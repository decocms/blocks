import { createDecoImageLoader, nextImageOptimizer } from "@decocms/nextjs/image-loader";
import { imageUrl } from "./imageUrl";

export default createDecoImageLoader(imageUrl, { fallback: nextImageOptimizer });
