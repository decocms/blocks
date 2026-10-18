import type { Blocks, Seo } from "@decocms/blocks";
import type { BlockDescriptor, ProductHeroProps, PromoBannerProps, ResolvedPage } from "../src/model";

export default {
  page: (input: ResolvedPage<BlockDescriptor>) => input,
  seo: (input: Seo) => input,
  "promo-banner": (input: PromoBannerProps): BlockDescriptor => ({ component: "promo-banner", props: input }),
  "product-hero": (input: ProductHeroProps): BlockDescriptor => ({ component: "product-hero", props: input }),
} satisfies Blocks;
