/**
 * Test doubles for the worker's tests: a site's page cache over an in-memory
 * Cache API, an execution context that collects `waitUntil` work, a CMS over
 * an in-memory release, and a server entry that records what it was asked.
 * Not exported by the package.
 */
import { type Blocks, type CMS, createCMS, type Snapshot } from "@decocms/blocks";
import { currentScope, type RequestScope } from "@decocms/tanstack/scope";
import type { ExecutionContextLike, PageCache, PageRequest } from "./index.ts";

export class MemoryCache {
  readonly entries = new Map<string, Response>();

  async match(key: Request): Promise<Response | undefined> {
    const hit = this.entries.get(key.url);
    return hit ? hit.clone() : undefined;
  }

  async put(key: Request, response: Response): Promise<void> {
    // The Cache API reads the body now; keep a copy with its headers.
    const body = await response.arrayBuffer();
    this.entries.set(key.url, new Response(body, response));
  }

  async delete(key: Request): Promise<boolean> {
    return this.entries.delete(key.url);
  }

  /** The stored copies' keys. */
  pageKeys(): string[] {
    return [...this.entries.keys()];
  }

  /** The stored copies. */
  pages(): Response[] {
    return [...this.entries.values()];
  }
}

/**
 * The smallest site page cache: keyed by URL and device, `X-Cache` `HIT` or
 * `MISS`, storing a 200 that sets no cookie. `seen` holds each request it
 * was called for. The full recipe and its tests are
 * `examples/tanstack-worker-smoke`'s worker entry.
 */
export function testPageCache() {
  const store = new MemoryCache();
  const seen: PageRequest[] = [];
  const pageCache: PageCache = async (page) => {
    seen.push(page);
    const key = new Request(`${page.url.href}#${page.device}`);
    const hit = await store.match(key);
    const response = hit ?? (await page.render({ csegToken: "a1b2c3d4" }));
    if (!hit && response.status === 200 && !response.headers.has("set-cookie")) {
      await store.put(key, response.clone());
    }
    const out = new Response(response.body, response);
    out.headers.set("X-Cache", hit ? "HIT" : "MISS");
    return out;
  };
  return { store, seen, pageCache };
}

export class TestContext implements ExecutionContextLike {
  readonly work: Promise<unknown>[] = [];
  waitUntil(promise: Promise<unknown>): void {
    this.work.push(promise);
  }
  async settle(): Promise<void> {
    while (this.work.length) await Promise.allSettled(this.work.splice(0));
  }
}

/**
 * A release with a page, a redirect, a block that varies on the `buy-button`
 * test and, when given, the `CMS` block's preview hosts and the saved
 * `experiments` and `campaigns` blocks.
 */
export function snapshot(
  options: {
    revision?: string;
    previewHosts?: string[];
    experiments?: Record<string, number>;
    campaigns?: Record<string, { start?: string; end?: string }>;
  } = {},
): Snapshot {
  const blocks: Record<string, unknown> = {
    Home: { __resolveType: "page", path: "/", sections: [] },
    "Old shoes": { __resolveType: "redirect", from: "/old-shoes", to: "/shoes", permanent: true },
    BuyButton: {
      __resolveType: "multivariate",
      variants: [
        { rule: { __resolveType: "experiment", name: "buy-button" }, value: "new" },
        { rule: { __resolveType: "always" }, value: "old" },
      ],
    },
  };
  if (options.previewHosts) {
    blocks.CMS = { __resolveType: "cms-settings", preview: { hosts: options.previewHosts } };
  }
  if (options.experiments) {
    blocks.experiments = { __resolveType: "split-traffic", ...options.experiments };
  }
  if (options.campaigns) {
    blocks.campaigns = { __resolveType: "date-windows", ...options.campaigns };
  }
  return { revision: options.revision ?? "rev-1", blocks } as Snapshot;
}

let cmsCount = 0;

/** A CMS of its own (a fresh content root) over `content`. */
export function testCMS(content: Snapshot = snapshot()): CMS {
  cmsCount += 1;
  return createCMS({
    blocks: {} as Blocks,
    content: { ...content, root: `/test-cms-${cmsCount}` } as Snapshot & { root: string },
  });
}

export interface Served {
  url: string;
  method: string;
  headers: Headers;
  scope: RequestScope | undefined;
}

/**
 * A server entry answering `respond(request)` (HTML by default), recording
 * each request and the request scope it ran in.
 */
export function recordingEntry(respond?: (request: Request) => Response | Promise<Response>) {
  const served: Served[] = [];
  return {
    served,
    fetch: async (request: Request) => {
      served.push({
        url: request.url,
        method: request.method,
        headers: new Headers(request.headers),
        scope: currentScope(),
      });
      return respond
        ? respond(request)
        : new Response(`<!doctype html><p>${new URL(request.url).pathname}</p>`, {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
    },
  };
}

export const POINTER = "studio.decocms.com/api/acme/decofile/store/main/changes?token=abc@9f3c1a";

export function html(body = "<p>ok</p>", headers: Record<string, string> = {}): Response {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}

export interface MetricPoint {
  name: string;
  labels: Record<string, unknown>;
  seconds: number;
}

const TELEMETRY_SINK = Symbol.for("decocms.blocks.telemetry");

/**
 * Stands in for the CMS's telemetry pipeline (the process's sink, where a
 * `createCMS` with telemetry puts its own): records each histogram. `measuring`
 * false is telemetry with `metrics: false`.
 */
export function recordMetrics(options: { measuring?: boolean; throws?: boolean } = {}) {
  const points: MetricPoint[] = [];
  (globalThis as Record<symbol, unknown>)[TELEMETRY_SINK] = {
    measuring: () => options.measuring ?? true,
    histogram: (name: string, labels: Record<string, unknown>, seconds: number) => {
      if (options.throws) throw new Error("sink failed");
      points.push({ name, labels, seconds });
    },
  };
  return points;
}

export function removeMetrics(): void {
  delete (globalThis as Record<symbol, unknown>)[TELEMETRY_SINK];
}
