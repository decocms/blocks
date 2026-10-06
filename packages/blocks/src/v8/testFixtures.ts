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

/** The host and token of the fake Studio API below. */
export const STUDIO_HOST = "studio.decocms.com";
export const STUDIO_TOKEN = "signed-token";

/**
 * A fake Studio API answering draft pointers the way the docs describe
 * (/next/content-delivery#draft-previews): per draft branch, the changes
 * compared with production, behind the token Studio signed. Hand `fetch` to
 * `vi.stubGlobal("fetch", …)`.
 */
export function fakeStudio() {
  const branches = new Map<string, { set?: Record<string, unknown>; delete?: string[] }>();
  const overrides = new Map<string, () => Response>();
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const PATH = /^\/api\/acme\/decofile\/store\/([^/]+)\/changes$/;
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    requests.push({ url: url.href, init });
    const branch = PATH.exec(url.pathname)?.[1];
    if (url.host !== STUDIO_HOST || branch === undefined) {
      return new Response("not found", { status: 404 });
    }
    const override = overrides.get(branch);
    if (override) return override();
    if (url.searchParams.get("token") !== STUDIO_TOKEN) {
      return Response.json({ error: "invalid token" }, { status: 401 });
    }
    const changes = branches.get(branch) ?? {};
    return Response.json(
      { format: 1, set: changes.set ?? {}, delete: changes.delete ?? [] },
      { headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } },
    );
  };
  return {
    fetch,
    requests,
    /** Saves a draft branch's changes and returns the pointer Studio would mint for them. */
    draft(
      changes: { set?: Record<string, unknown>; delete?: string[] },
      { branch = "summer-sale", version = "9f3c1a", token = STUDIO_TOKEN } = {},
    ): string {
      branches.set(branch, changes);
      return `${STUDIO_HOST}/api/acme/decofile/store/${branch}/changes?token=${token}@${version}`;
    },
    /** Answers a branch with this response instead. */
    respond(branch: string, response: () => Response) {
      overrides.set(branch, response);
    },
  };
}
