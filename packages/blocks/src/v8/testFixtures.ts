/**
 * The docs' running examples (blocks, saved blocks, how resolution works,
 * routing), as one block map and one content module, shared by the v8 tests.
 */
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
 * (/next/content-delivery#draft-previews): `sites/<site>/drafts/<slug>.json`
 * is `{ set, delete }`, served `no-cache` with an ETag that changes on every
 * save, and a `304` to an `If-None-Match` that still matches. Hand `fetch` to
 * `vi.stubGlobal("fetch", …)`.
 */
export function fakeStudio() {
  const drafts = new Map<
    string,
    { body: { set: Record<string, unknown>; delete: string[] }; etag: string }
  >();
  const overrides = new Map<string, () => Response>();
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const PATH = /^\/sites\/acme\/drafts\/([^/]+)\.json$/;
  let saves = 0;
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    requests.push({ url: url.href, init });
    const slug = PATH.exec(url.pathname)?.[1];
    if (url.host !== DRAFT_HOST || slug === undefined) {
      return new Response("not found", { status: 404 });
    }
    const override = overrides.get(slug);
    if (override) return override();
    const draft = drafts.get(slug);
    if (draft === undefined) return new Response("not found", { status: 404 });
    const headers = {
      "cache-control": "no-cache, max-age=0, must-revalidate",
      etag: draft.etag,
    };
    if (new Headers(init?.headers).get("if-none-match") === draft.etag) {
      return new Response(null, { status: 304, headers });
    }
    return Response.json(draft.body, { headers });
  };
  return {
    fetch,
    requests,
    /** Saves a draft (Studio's R2 write) and returns the pointer Studio would hand out. */
    draft(
      changes: { set?: Record<string, unknown>; delete?: string[] },
      { slug = "summer-sale", version = "9f3c1a" }: { slug?: string; version?: string } = {},
    ): string {
      drafts.set(slug, {
        body: { set: changes.set ?? {}, delete: changes.delete ?? [] },
        etag: `"etag-${++saves}"`,
      });
      return `${DRAFT_HOST}/sites/acme/drafts/${slug}.json@${version}`;
    },
    /** Answers a draft with this response instead. */
    respond(slug: string, response: () => Response) {
      overrides.set(slug, response);
    },
  };
}
