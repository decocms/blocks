/**
 * The docs' running examples (blocks, saved blocks, how resolution works,
 * routing), as one block map and one content module, shared by the v8 tests.
 */
import { indexEntry } from "./blockMeta";
import type { Blocks, Snapshot } from "./types";

export const seo = (props: { title: string; description: string }) => ({ ...props });

export const catalogProduct = ({ slug }: { slug: string }) => ({
  name: slug === "summer-shirt" ? "Summer shirt" : slug,
  slug,
});

export const productCard = (props: { title: string; product: unknown }) => ({
  component: "product-card",
  props,
});

export const promoBanner = (props: { title: string; href: string }) => ({
  component: "promo-banner",
  props,
});

export const hero = (props: { title: string; image?: string }) => ({ component: "hero", props });

export function docsBlocks(): Blocks {
  return {
    seo,
    "catalog-product": catalogProduct,
    "product-card": productCard,
    "promo-banner": promoBanner,
    hero,
    post: (props: unknown) => props,
  };
}

export function docsSnapshot(revision = "rev-1"): Snapshot {
  return {
    revision,
    blocks: {
      SummerSEO: {
        __resolveType: "seo",
        title: "Sunny!",
        description: "Light layers for long days.",
      },
      CurrentProduct: { __resolveType: "catalog-product", slug: "summer-shirt" },
      SummerCard: {
        __resolveType: "product-card",
        title: "Summer collection",
        product: { __resolveType: "CurrentProduct" },
      },
      SummerPage: {
        __resolveType: "page",
        name: "Summer campaign",
        path: "/summer",
        seo: { __resolveType: "SummerSEO" },
        sections: [
          {
            __resolveType: "hero",
            title: "Summer starts here",
            image: "https://cdn.example.com/summer.jpg",
          },
        ],
      },
      HomePage: {
        __resolveType: "page",
        name: "Home",
        path: "/",
        sections: [{ __resolveType: "SummerCard" }],
      },
      LegacySummer: {
        __resolveType: "redirect",
        from: "/campaigns/summer",
        to: "/summer",
        permanent: true,
      },
      HelloWorld: {
        __resolveType: "post",
        name: "Hello, world",
        path: "/blog/hello-world",
        date: "2026-09-01",
        body: "…",
      },
    },
  };
}

/** The host of the fake delivery CDN below. */
export const DRAFT_HOST = "delivery.decocms.com";

/**
 * A fake delivery CDN answering draft pointers the way the docs describe
 * (/next/content-delivery#draft-previews): a draft is a folder,
 * `sites/acme/drafts/<slug>/`, with `index.json` (`{ names }`) and one file
 * per name (`{ operation: "set", data }` or `{ operation: "delete" }`), served
 * `no-cache`. Hand `fetch` to `vi.stubGlobal("fetch", …)`.
 */
export function fakeStudio() {
  /** slug → name → file body. */
  const drafts = new Map<string, Map<string, unknown>>();
  const overrides = new Map<string, () => Response>();
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const PATH = /^\/sites\/acme\/drafts\/([^/]+)\/([^/]+)$/;
  const headers = { "cache-control": "no-cache, max-age=0, must-revalidate" };
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    requests.push({ url: url.href, init });
    const match = PATH.exec(url.pathname);
    if (url.host !== DRAFT_HOST || match === null) {
      return new Response("not found", { status: 404 });
    }
    const [, slug, file] = match as unknown as [string, string, string];
    const override = overrides.get(slug);
    if (override) return override();
    const draft = drafts.get(slug);
    if (draft === undefined) return new Response("not found", { status: 404 });
    if (file === "index.json")
      return Response.json({ names: [...draft.keys()].sort() }, { headers });
    // The file's key is the name's file name, sent encoded once more.
    const key = decodeURIComponent(file);
    const name = key === "%69ndex.json" ? "index" : decodeURIComponent(key.slice(0, -5));
    if (draft.get(name) === undefined) return new Response("not found", { status: 404 });
    return Response.json(draft.get(name), { headers });
  };
  return {
    fetch,
    requests,
    /** Saves a draft (Studio's R2 writes) and returns the pointer Studio would hand out. */
    draft(
      changes: { set?: Record<string, unknown>; delete?: string[] },
      { slug = "summer-sale", version = "9f3c1a" }: { slug?: string; version?: string } = {},
    ): string {
      const files = new Map<string, unknown>();
      for (const [name, data] of Object.entries(changes.set ?? {})) {
        files.set(name, { operation: "set", data, user: "usr_1", via: "studio", at: 1 });
      }
      for (const name of changes.delete ?? []) {
        files.set(name, { operation: "delete", user: "usr_1", via: "studio", at: 1 });
      }
      drafts.set(slug, files);
      return `${DRAFT_HOST}/sites/acme/drafts/${slug}/index.json@${version}`;
    },
    /** Writes one draft file as is (a `published` marker, a malformed body). */
    file(slug: string, name: string, body: unknown) {
      const files = drafts.get(slug) ?? new Map<string, unknown>();
      files.set(name, body);
      drafts.set(slug, files);
    },
    /** Answers every read of a draft's folder with this response instead. */
    respond(slug: string, response: () => Response) {
      overrides.set(slug, response);
    },
  };
}

/** A revision id (`<inv>-<uuidv7>`) per number, distinct and valid. */
export function revisionId(n: number): string {
  const hex = n.toString(16).padStart(12, "0");
  return `${hex}-0193a1f2-6800-7c3e-9d2a-${hex}`;
}

/** One request the fake delivery CDN saw. */
export interface DeliveryRequest {
  url: string;
  /** The path under the site, such as `latest.json` or `blocks/<hash>.json`. */
  key: string;
  headers: Record<string, string>;
  init: RequestInit | undefined;
}

/**
 * A fake delivery CDN with the hosted layout (/next/hosted-releases-internals):
 * `sites/<site>/latest.json` (with an ETag; a 304 to a matching
 * `If-None-Match`), `revisions/<id>/index.json` and immutable
 * `blocks/<hash>.json`. `publish` writes a revision as Studio does: block
 * objects, then the revision index, then `latest.json`.
 */
export function fakeDelivery(site = "acme", origin = "https://delivery.decocms.com") {
  const prefix = `${origin}/sites/${site}/`;
  const objects = new Map<string, { body: unknown; etag: string }>();
  const gates = new Map<string, Promise<void>>();
  const overrides = new Map<string, () => Response | Promise<Response>>();
  const requests: DeliveryRequest[] = [];
  let sequence = 0;
  let writes = 0;
  let published: { revision: string; sequence: number; blocks: Record<string, unknown> } | null =
    null;
  const put = (key: string, body: unknown) => {
    objects.set(key, { body, etag: `"e${++writes}"` });
  };
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const key = url.startsWith(prefix) ? url.slice(prefix.length) : url;
    requests.push({ url, key, headers, init });
    const gate = gates.get(key);
    if (gate) {
      const signal = init?.signal;
      await Promise.race([
        gate,
        new Promise((_, reject) => {
          if (signal?.aborted) reject(signal.reason);
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      ]);
    }
    const override = overrides.get(key);
    if (override) return override();
    const object = objects.get(key);
    if (object === undefined) return new Response("not found", { status: 404 });
    if (object.body instanceof Response) return object.body.clone();
    if (headers["if-none-match"] === object.etag) {
      return new Response(null, { status: 304, headers: { etag: object.etag } });
    }
    return new Response(JSON.stringify(object.body), {
      headers: { "content-type": "application/json", etag: object.etag },
    });
  };
  return {
    fetch,
    requests,
    /** The keys requested, in order. */
    keys: () => requests.map((r) => r.key),
    /** How many requests went to `blocks/`. */
    blockFetches: () => requests.filter((r) => r.key.startsWith("blocks/")).length,
    /** Studio's publish: block objects, the revision index, then latest.json. */
    async publish(
      blocks: Record<string, unknown>,
      options: { previewHosts?: string[]; sequence?: number } = {},
    ) {
      sequence = options.sequence ?? sequence + 1;
      const revision = revisionId(sequence);
      const names = Object.keys(blocks);
      const index: Record<string, unknown> = {};
      for (const name of names) {
        const entry = await indexEntry(name, blocks[name], names);
        index[name] = entry;
        put(`blocks/${entry.version}.json`, blocks[name]);
      }
      const body = { revision, sequence, blocks: index };
      put(`revisions/${revision}/index.json`, body);
      put("latest.json", { ...body, previewHosts: options.previewHosts ?? ["*.example.com"] });
      published = { revision, sequence, blocks: index };
      return published;
    },
    /** The hash a published name has. */
    hashOf(name: string): string {
      const entry = published?.blocks[name] as { version: string } | undefined;
      if (entry === undefined) throw new Error(`"${name}" isn't published`);
      return entry.version;
    },
    put,
    remove(key: string) {
      objects.delete(key);
    },
    /** Answers `key` with this response instead (every time, until cleared with `null`). */
    respond(key: string, response: (() => Response | Promise<Response>) | null) {
      if (response === null) overrides.delete(key);
      else overrides.set(key, response);
    },
    /** Holds every fetch of `key` until released (or its signal aborts). */
    hold(key: string) {
      let release!: () => void;
      gates.set(
        key,
        new Promise<void>((r) => {
          release = r;
        }),
      );
      return () => {
        gates.delete(key);
        release();
      };
    },
  };
}
