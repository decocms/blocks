/**
 * `@decocms/nextjs/instrumentation`: `http.server.request.duration` for a
 * Next.js site, from the request span Next.js already opens.
 *
 * Next.js measures every request it serves: `BaseServer.handleRequest` opens
 * one root span per request and, when the response is done, sets its status,
 * its method and, when Next routed it, the route's template (`/[slug]/p`,
 * not the path). It creates spans only while a tracer provider is registered
 * through `@opentelemetry/api` (the app's copy, or Next's compiled one when
 * the app has none; both read the same global registration).
 *
 * `register()`, the site's `instrumentation.ts` hook, registers a provider
 * whose only job is that span: when it ends, the request is recorded with
 * `recordServerRequest` from `@decocms/blocks/metrics`, into the CMS's
 * telemetry in the same process. No span is exported anywhere and every other
 * span Next.js asks for is a shared non-recording one. With no
 * `@opentelemetry/api` reachable, on the Edge runtime, or when another
 * provider is already registered, it registers nothing and never throws.
 *
 * A site that registers its own OpenTelemetry SDK (`@vercel/otel`,
 * `NodeSDK`) adds `serverRequestSpanProcessor()` to that SDK's span
 * processors instead.
 *
 * Labels: `http.route` is Next's route template (`unmatched` when Next names
 * none); RSC requests count under their page's route, as the requests they
 * are. `cache` is `DRAFT` for a draft render (the proxy forwarded
 * `x-deco-version`, or the request was rewritten onto `/_draft`) and otherwise
 * `BYPASS`: Next decides its cache (`x-nextjs-cache`) on the response, which
 * the span never sees.
 */

import { recordServerRequest } from "@decocms/blocks/metrics";
import type {
  Context,
  ContextManager,
  Span,
  SpanContext,
  SpanOptions,
  TextMapPropagator,
  Tracer,
  TracerProvider,
} from "@opentelemetry/api";
import { DRAFT_ROUTE_PREFIX, VERSION_HEADER } from "../draft.ts";

type Api = typeof import("@opentelemetry/api");

/** The span type Next.js gives its one root span per request. */
const ROOT_SPAN_TYPE = "BaseServer.handleRequest";
const REGISTERED = Symbol.for("decocms.nextjs.instrumentation");
/**
 * Under `next start`, the router runs the proxy (`proxy.ts`/`middleware.ts`)
 * through a `handleRequest` of its own, which ends by "bubbling" the proxy's
 * result back to the router (`next.bubble`). That span is the proxy's, not a
 * request: the request it hands on is measured by its own span.
 */
const BUBBLE = "next.bubble";

type Attributes = Record<string, unknown>;

interface AsyncLocalStorageLike<T> {
  getStore(): T | undefined;
  run<R>(store: T, fn: (...args: unknown[]) => R, ...args: unknown[]): R;
  disable(): void;
}

/** What `serverRequestSpanProcessor()` reads from an ended span (an SDK's `ReadableSpan`). */
interface EndedSpan {
  readonly attributes: Attributes;
  /** `[seconds, nanoseconds]`, as OpenTelemetry's `HrTime`. */
  readonly duration: readonly [number, number];
  readonly status?: { readonly code: number };
}

/** An OpenTelemetry SDK `SpanProcessor` that records nothing but the request metric. */
export interface ServerRequestSpanProcessor {
  onStart(span: unknown, parentContext: unknown): void;
  onEnd(span: EndedSpan): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

/** OpenTelemetry's `SpanStatusCode.ERROR`. */
const STATUS_ERROR = 2;

/** Records one ended `BaseServer.handleRequest` span. Never throws. */
function recordRequestSpan(
  attributes: Attributes,
  seconds: number,
  errored: boolean,
  draft: boolean,
): void {
  const route = typeof attributes["http.route"] === "string" ? attributes["http.route"] : undefined;
  const code = Number(attributes["http.status_code"]);
  // Next sets the status before the span ends; a request that threw is a 5xx whatever it says.
  const status = errored && !(code >= 500) ? 500 : code || 500;
  // Never rejects; the span's route is already a string, so nothing to wait for.
  void recordServerRequest({
    route,
    method: String(attributes["http.method"] ?? ""),
    status,
    cache: draft || isDraftRoute(route) ? "DRAFT" : "BYPASS",
    seconds,
  });
}

function isDraftRoute(route: string | undefined): boolean {
  if (route === undefined) return false;
  const path = route.replace(/^\/%5Fdraft(?=\/|$)/i, DRAFT_ROUTE_PREFIX);
  return path === DRAFT_ROUTE_PREFIX || path.startsWith(`${DRAFT_ROUTE_PREFIX}/`);
}

/**
 * For a site with its own OpenTelemetry SDK: a span processor that records
 * `http.server.request.duration` from Next's request span and leaves every
 * span to the SDK's other processors and exporters.
 *
 * ```ts
 * registerOTel({ serviceName: "my-store", spanProcessors: ["auto", serverRequestSpanProcessor()] });
 * ```
 */
export function serverRequestSpanProcessor(): ServerRequestSpanProcessor {
  return {
    onStart() {},
    onEnd(span) {
      try {
        const attributes = span.attributes;
        if (attributes?.["next.span_type"] !== ROOT_SPAN_TYPE || attributes[BUBBLE] === true)
          return;
        const [s, ns] = span.duration;
        recordRequestSpan(attributes, s + ns / 1e9, span.status?.code === STATUS_ERROR, false);
      } catch {
        // A metric never breaks a request.
      }
    },
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
}

/**
 * The site's `instrumentation.ts` hook:
 *
 * ```ts
 * // instrumentation.ts
 * export { register } from "@decocms/nextjs/instrumentation";
 * ```
 *
 * Registers the request-metric tracer provider, once per process. Does
 * nothing on the Edge runtime (the Node.js server's request span covers the
 * Edge pages it serves), without `@opentelemetry/api` (the app's or Next's),
 * without `AsyncLocalStorage`, or when another provider is registered (it
 * then says to use `serverRequestSpanProcessor()`). Never throws.
 */
export async function register(): Promise<void> {
  try {
    const global = globalThis as Record<PropertyKey, unknown>;
    if (global[REGISTERED] === true || typeof global.EdgeRuntime === "string") return;
    const Storage = global.AsyncLocalStorage as
      | (new () => AsyncLocalStorageLike<Context>)
      | undefined;
    if (typeof Storage !== "function") return;
    const api = await loadApi();
    if (api === undefined) return;
    global[REGISTERED] = true;
    const draft = api.createContextKey("decocms.nextjs.draft");
    if (!api.trace.setGlobalTracerProvider(requestTracerProvider(api, draft))) {
      console.warn(
        "[@decocms/nextjs] Another OpenTelemetry tracer provider is registered, so register() added nothing. " +
          "To record http.server.request.duration, add serverRequestSpanProcessor() to that provider's span processors.",
      );
      return;
    }
    // Both may already be registered by something else; Next's spans work with either.
    api.context.setGlobalContextManager(storageContextManager(api, new Storage()));
    api.propagation.setGlobalPropagator(draftPropagator(draft));
  } catch {
    // Instrumentation never stops a server from starting.
  }
}

/**
 * The `@opentelemetry/api` Next.js uses: the app's own when installed (Next's
 * bundlers alias it to Next's compiled copy when it isn't), else Next's
 * compiled copy.
 */
async function loadApi(): Promise<Api | undefined> {
  try {
    return await import("@opentelemetry/api");
  } catch {
    try {
      return (await import("next/dist/compiled/@opentelemetry/api/index.js")) as Api;
    } catch {
      return undefined;
    }
  }
}

function requestTracerProvider(api: Api, DRAFT: symbol): TracerProvider {
  const IN_REQUEST = api.createContextKey("decocms.nextjs.inRequest");
  const inert = api.trace.wrapSpanContext(api.INVALID_SPAN_CONTEXT);

  const tracer: Tracer = {
    startSpan(_name: string, options?: SpanOptions, context?: Context): Span {
      const ctx = context ?? api.context.active();
      if (options?.attributes?.["next.span_type"] !== ROOT_SPAN_TYPE) return inert;
      // A request Next serves inside another (a nested handleRequest) is already measured.
      if (ctx.getValue(IN_REQUEST) === true) return inert;
      return new RequestSpan(
        api.INVALID_SPAN_CONTEXT,
        options.attributes,
        ctx.getValue(DRAFT) === true,
      );
    },
    startActiveSpan(name: string, ...rest: unknown[]) {
      const fn = rest[rest.length - 1] as (span: Span) => unknown;
      const options = (rest.length > 1 ? rest[0] : undefined) as SpanOptions | undefined;
      const context = (rest.length > 2 ? rest[1] : undefined) as Context | undefined;
      const span = tracer.startSpan(name, options, context);
      // Only the request span changes the context; every other span costs a call.
      if (span === inert) return fn(span);
      const ctx = api.trace
        .setSpan(context ?? api.context.active(), span)
        .setValue(IN_REQUEST, true);
      return api.context.with(ctx, fn, undefined, span);
    },
  } as Tracer;

  // Not named NoopTracerProvider: Next checks that name to decide whether tracing is on.
  return { getTracer: () => tracer };
}

/** Marks the request's context when the proxy forwarded an accepted draft. */
function draftPropagator(DRAFT: symbol): TextMapPropagator {
  return {
    inject() {},
    extract(context, carrier, getter) {
      try {
        const value = getter.get(carrier, VERSION_HEADER);
        return value !== undefined && value !== "" ? context.setValue(DRAFT, true) : context;
      } catch {
        return context;
      }
    },
    fields: () => [],
  };
}

/** The request span: keeps only the attributes the metric needs and records on `end()`. */
class RequestSpan implements Span {
  readonly #context: SpanContext;
  readonly #attributes: Attributes = {};
  readonly #start = performance.now();
  readonly #draft: boolean;
  #errored = false;
  #proxy = false;
  #ended = false;

  constructor(context: SpanContext, attributes: Attributes | undefined, draft: boolean) {
    this.#context = context;
    this.#draft = draft;
    if (attributes) this.setAttributes(attributes);
  }

  spanContext(): SpanContext {
    return this.#context;
  }
  setAttribute(key: string, value: unknown): this {
    if (key === "http.route" || key === "http.status_code" || key === "http.method") {
      this.#attributes[key] = value;
    } else if (key === BUBBLE && value === true) {
      this.#proxy = true;
    }
    return this;
  }
  setAttributes(attributes: Attributes): this {
    for (const key in attributes) this.setAttribute(key, attributes[key]);
    return this;
  }
  setStatus(status: { code: number }): this {
    if (status?.code === STATUS_ERROR) this.#errored = true;
    return this;
  }
  addEvent(): this {
    return this;
  }
  addLink(): this {
    return this;
  }
  addLinks(): this {
    return this;
  }
  updateName(): this {
    return this;
  }
  recordException(exception: unknown): void {
    // The proxy's own invocation ends with an error marked `bubble`, whatever its type.
    if ((exception as { bubble?: unknown } | null)?.bubble === true) this.#proxy = true;
  }
  isRecording(): boolean {
    return !this.#ended;
  }
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#proxy) return;
    try {
      const seconds = (performance.now() - this.#start) / 1000;
      recordRequestSpan(this.#attributes, seconds, this.#errored, this.#draft);
    } catch {
      // A metric never breaks a request.
    }
  }
}

/** OpenTelemetry's context manager over `AsyncLocalStorage` (what `@opentelemetry/context-async-hooks` does). */
function storageContextManager(api: Api, storage: AsyncLocalStorageLike<Context>): ContextManager {
  const manager: ContextManager = {
    active: () => storage.getStore() ?? api.ROOT_CONTEXT,
    with(context, fn, thisArg, ...args) {
      const call = thisArg === undefined ? fn : fn.bind(thisArg);
      return storage.run(context, call as (...a: unknown[]) => ReturnType<typeof fn>, ...args);
    },
    bind<T>(context: Context, target: T): T {
      if (typeof target !== "function") return target;
      const fn = target as unknown as (...a: unknown[]) => unknown;
      return function (this: unknown, ...args: unknown[]) {
        return manager.with(context, () => fn.apply(this, args));
      } as unknown as T;
    },
    enable: () => manager,
    disable() {
      storage.disable();
      return manager;
    },
  };
  return manager;
}
