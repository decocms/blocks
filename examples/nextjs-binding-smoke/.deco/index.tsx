import type { Blocks, Seo } from "@decocms/blocks";
import ProductHero from "../src/ProductHero";
import PromoBanner from "../src/PromoBanner";
import type { ProductHeroProps, PromoBannerProps } from "../src/model";
import type { Post } from "../src/post";

export default {
  seo: (input: Seo) => input,
  "promo-banner": (input: PromoBannerProps) => <PromoBanner {...input} />,
  "product-hero": (input: ProductHeroProps) => <ProductHero {...input} />,
  post: (props: Post) => props,
} satisfies Blocks;
