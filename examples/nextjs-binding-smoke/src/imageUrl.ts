import { createImageUrl, decoCdn } from "@decocms/blocks/image";

export const imageUrl = createImageUrl({ providers: [decoCdn()] });
