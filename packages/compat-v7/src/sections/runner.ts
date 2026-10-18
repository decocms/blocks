/**
 * v7's section loader runner (`@decocms/blocks@7` cms/sectionLoaders.ts),
 * request-explicit. v7 ran a section's registered `(props, req)` loader after
 * the page resolved, then the loaders of the sections it held, and handed the
 * result to the component. The rules kept here, with v7's results:
 *
 * - every section of the page (site globals included) runs its loader, in
 *   parallel; a section without one passes through;
 * - after a section's own loader, the sections in its props run theirs:
 *   wherever they sit (7.77.13 and later, `nested: "deep"`, the default), or
 *   only directly in a prop or a list prop (7.77.12 and earlier,
 *   `nested: "direct"`);
 * - the loader gets the props with `__pageUrl` and `__pagePath` added (a
 *   value already in the props wins), and a request for the page: its URL,
 *   the incoming request's headers;
 * - a loader that throws leaves the section's saved props, and the section
 *   counts as degraded unless it is non-critical.
 *
 * Not kept: v7's caches (layout sections, `registerCacheableSections`) and
 * its registries; the loaders are an argument. There is no `ctx`: the third
 * argument throws on any read, so a loader still written against v7's
 * `ctx` fails with the way out, and the runner keeps its saved props.
 */

/** A section loader, as v7 registered it: the section's props and the page's request in, props out. */
export type SectionLoaderFn = (
  props: Record<string, unknown>,
  req: Request,
  /** v7's `ctx`. Gone in v8: reading it throws. */
  ctx?: never,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

/** A section: v8's `{ component, props }` descriptor, at the top of a page or in another section's props. */
export interface Section {
  component: string;
  props: Record<string, unknown>;
}

export interface RunSectionLoadersOptions {
  /**
   * The loaders by section component, as v7's `registerSectionLoaders` took
   * them (`"site/sections/Product/ProductShelf.tsx": withDevice()`).
   */
  loaders: Readonly<
    Record<string, ((props: any, req: Request, ctx?: never) => unknown) | undefined>
  >;
  /** The request being served. */
  request: Request;
  /**
   * The page's URL, when it isn't `request.url`: on a client-side navigation
   * the request is the framework's server-function call, and v7 gave loaders
   * the page being navigated to (v7 #280). Defaults to `request.url`.
   */
  url?: string | URL;
  /**
   * Sections whose loader failing doesn't degrade the page, as v7's
   * `registerNonCriticalSections`. Put v7's layout sections here too: v7
   * never marked a layout section degraded.
   */
  nonCritical?: Iterable<string>;
  /**
   * Which nested sections run their loaders: `"deep"` (7.77.13 and later,
   * the default) finds a section anywhere in the props, `"direct"` (7.77.12
   * and earlier) only directly in a prop or in a list prop.
   */
  nested?: "deep" | "direct";
}

export interface SectionLoadersResult<S> {
  /** The sections with their loaders' props, in order. */
  sections: S[];
  /** Critical sections (theirs or nested) whose loader threw. v7 sent `X-Deco-Degraded` when any did. */
  degraded: string[];
}

interface Run {
  loaders: RunSectionLoadersOptions["loaders"];
  request: Request;
  nonCritical: Set<string>;
  nested: "deep" | "direct";
  degraded: Set<string>;
}

function start(options: RunSectionLoadersOptions): Run {
  const { request } = options;
  if (!(request instanceof Request)) {
    throw new TypeError(
      "@decocms/compat-v7/sections: pass the request being served: runSectionLoaders(sections, { loaders, request }).",
    );
  }
  return {
    loaders: options.loaders,
    // v7's page route handed loaders a GET for the page with the request's headers.
    request: new Request(String(options.url ?? request.url), { headers: request.headers }),
    nonCritical: new Set(options.nonCritical ?? []),
    nested: options.nested ?? "deep",
    degraded: new Set(),
  };
}

/**
 * Runs the loaders of a page's sections, and of the sections they hold, as
 * v7 did after the page resolved. Run it once per page, over every section
 * (globals included); a section's block function shouldn't also run it, or
 * nested loaders run twice.
 */
export async function runSectionLoaders<S extends Section>(
  sections: readonly S[],
  options: RunSectionLoadersOptions,
): Promise<SectionLoadersResult<S>> {
  const run = start(options);
  const out = await Promise.all(sections.map((section) => runSection(section, run)));
  return { sections: out, degraded: [...run.degraded] };
}

/** {@link runSectionLoaders} for one section (v7's `runSingleSectionLoader`, a deferred section's path). */
export async function runSectionLoader<S extends Section>(
  section: S,
  options: RunSectionLoadersOptions,
): Promise<{ section: S; degraded: string[] }> {
  const run = start(options);
  const out = await runSection(section, run);
  return { section: out, degraded: [...run.degraded] };
}

/**
 * The third argument a loader gets. v7 passed `ctx` (device, `ctx.invoke`,
 * app state, `ctx.response`); v8 has none of it, so any read throws and
 * names the replacement. `then` reads as absent, so awaiting it is harmless.
 */
function goneCtx(component: string): never {
  const fail = (key: PropertyKey): never => {
    throw new Error(
      `@decocms/compat-v7/sections: the loader of "${component}" read ctx.${String(key)}, ` +
        'and v8 has no ctx. Read the device with detectDevice(req.headers.get("user-agent") ?? "") ' +
        "(@decocms/compat-v7/device), call the app's client or the site's server function instead of " +
        "ctx.invoke, and pass settings in instead of reading app state. The section keeps its saved props.",
    );
  };
  return new Proxy(Object.create(null), {
    get: (_, key) => (typeof key === "symbol" || key === "then" ? undefined : fail(key)),
    has: (_, key) => fail(key),
    set: (_, key) => fail(key),
    ownKeys: () => fail("keys"),
    defineProperty: (_, key) => fail(key),
    deleteProperty: (_, key) => fail(key),
  }) as never;
}

/** v7's `injectPageContext`: `__pageUrl` and `__pagePath`, unless the props have them. */
function injectPageContext(
  props: Record<string, unknown>,
  request: Request,
): Record<string, unknown> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return props;
  }
  const enriched = { ...props } as Record<string, unknown>;
  if (enriched.__pageUrl === undefined) enriched.__pageUrl = request.url;
  if (enriched.__pagePath === undefined) enriched.__pagePath = url.pathname;
  return enriched;
}

/** v7's `runSingleSectionLoaderImpl`, without the layout and cacheable tiers. */
async function runSection<S extends Section>(section: S, run: Run): Promise<S> {
  // Own keys only: a section named "constructor" has no loader (v7 kept them in a Map).
  const loader = Object.hasOwn(run.loaders, section.component)
    ? run.loaders[section.component]
    : undefined;
  let result: S;
  if (!loader) {
    result = section;
  } else {
    try {
      const enrichedProps = await loader(
        injectPageContext(section.props as Record<string, unknown>, run.request),
        run.request,
        goneCtx(section.component),
      );
      result = { ...section, props: enrichedProps };
    } catch (error) {
      console.error(`[SectionLoader] Error in "${section.component}":`, error);
      if (!run.nonCritical.has(section.component)) run.degraded.add(section.component);
      result = section;
    }
  }

  const props = result.props as Record<string, unknown> | undefined;
  if (props && typeof props === "object") {
    try {
      const enrichedProps =
        run.nested === "direct" ? await enrichDirect(props, run) : await enrichDeep(props, run);
      if (enrichedProps !== props) return { ...result, props: enrichedProps };
    } catch (error) {
      console.error(
        `[SectionLoader] Error enriching nested sections of "${section.component}":`,
        error,
      );
    }
  }
  return result;
}

/** v7's `isNestedSection`, for v8's descriptor (v7's resolver wrote `Component`; v8's sections write `component`). */
function isNestedSection(value: unknown): value is Section {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.component === "string" &&
    obj.props != null &&
    typeof obj.props === "object" &&
    !Array.isArray(obj.props)
  );
}

// ---------------------------------------------------------------------------
// 7.77.12 and earlier: sections directly in a prop or in a list prop
// ---------------------------------------------------------------------------

async function enrichDirect(
  props: Record<string, unknown>,
  run: Run,
): Promise<Record<string, unknown>> {
  const pending: { key: string; index?: number; promise: Promise<Section> }[] = [];
  for (const [key, value] of Object.entries(props)) {
    if (isNestedSection(value)) {
      pending.push({ key, promise: runSection(value, run) });
      continue;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (isNestedSection(item)) pending.push({ key, index: i, promise: runSection(item, run) });
      }
    }
  }
  if (pending.length === 0) return props;

  const results = await Promise.all(pending.map((p) => p.promise));
  const updated: Record<string, unknown> = { ...props };
  for (let i = 0; i < pending.length; i++) {
    const { key, index } = pending[i];
    if (index != null) {
      const current = updated[key];
      if (current === props[key]) updated[key] = [...(current as unknown[])];
      (updated[key] as unknown[])[index] = results[i];
    } else {
      updated[key] = results[i];
    }
  }
  return updated;
}

// ---------------------------------------------------------------------------
// 7.77.13 and later: sections anywhere in the props (7.x #648)
// ---------------------------------------------------------------------------

async function enrichDeep(
  props: Record<string, unknown>,
  run: Run,
): Promise<Record<string, unknown>> {
  const scan: SectionScan = { marked: new WeakSet(), deep: new WeakMap() };
  if (!markSectionSubtrees(props, scan, 0)) return props;
  return (await walkNested(props, run, scan.marked, new WeakMap())) as Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Below this depth the scan memoizes every node, so cyclic loader output terminates (v7's value). */
const CYCLE_GUARD_DEPTH = 32;

interface SectionScan {
  /** Arrays/plain objects whose subtree holds a nested section. */
  marked: WeakSet<object>;
  /** Scan results for nodes reached below CYCLE_GUARD_DEPTH. */
  deep: WeakMap<object, boolean>;
}

/** v7's `markSectionSubtrees`: whether `value` holds a section, marking the path to each. */
function markSectionSubtrees(value: unknown, scan: SectionScan, depth: number): boolean {
  if (isNestedSection(value)) return true;
  const isArray = Array.isArray(value);
  if (!isArray && !isPlainObject(value)) return false;
  const node = value as object;
  const guarded = depth >= CYCLE_GUARD_DEPTH;
  if (guarded) {
    const known = scan.deep.get(node);
    if (known !== undefined) return known;
    scan.deep.set(node, false);
  }
  let found = false;
  if (isArray) {
    const arr = value as unknown[];
    for (let i = 0; i < arr.length; i++) {
      if (markSectionSubtrees(arr[i], scan, depth + 1)) found = true;
    }
  } else {
    const obj = value as Record<string, unknown>;
    for (const key in obj) {
      if (markSectionSubtrees(obj[key], scan, depth + 1)) found = true;
    }
  }
  if (found) {
    scan.marked.add(node);
    if (guarded) scan.deep.set(node, true);
  }
  return found;
}

/**
 * v7's `walkNested`: the value with its sections' loaders run. A subtree
 * shared by several props is run once; a cycle keeps its original reference.
 */
function walkNested(
  value: unknown,
  run: Run,
  marked: WeakSet<object>,
  memo: WeakMap<object, Promise<unknown> | null>,
): unknown {
  if (isNestedSection(value)) return runSection(value, run);
  if (!value || typeof value !== "object" || !marked.has(value)) return value;
  const known = memo.get(value);
  if (known !== undefined) return known ?? value;
  memo.set(value, null);
  let pending: Promise<unknown>;
  if (Array.isArray(value)) {
    pending = Promise.all(value.map((item) => walkNested(item, run, marked, memo))).then((next) =>
      next.some((item, i) => item !== value[i]) ? next : value,
    );
  } else {
    const entries = Object.entries(value);
    pending = Promise.all(entries.map(([, v]) => walkNested(v, run, marked, memo))).then((next) => {
      let out: Record<string, unknown> | null = null;
      for (let i = 0; i < entries.length; i++) {
        if (next[i] !== entries[i][1]) {
          out ??= { ...value };
          out[entries[i][0]] = next[i];
        }
      }
      return out ?? value;
    });
  }
  memo.set(value, pending);
  return pending;
}
