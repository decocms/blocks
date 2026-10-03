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
