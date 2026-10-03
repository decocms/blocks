import type { Block, Route, Seo } from "@decocms/blocks";

export interface PromoBannerProps { title: string; href: string; }
export interface ProductHeroProps { name: string; price: number; currency: string; image: string; }

// What a block returns in data mode: a component name and its props.
export type BlockDescriptor =
  | { component: "promo-banner"; props: PromoBannerProps }
  | { component: "product-hero"; props: ProductHeroProps };

// A saved page, as client.list returns it by default (nothing run): seo and sections are still JSON.
export interface StoredPage extends Route {
  seo?: Seo | Block;
  sections: Block[] | Block;   // a list of blocks, or one multivariate block that picks a whole list
}

// What client.resolve returns for a page: seo and every block in sections resolved.
export interface ResolvedPage<T> extends Route { seo?: Seo; sections: T[]; }
