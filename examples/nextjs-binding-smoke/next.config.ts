import { withDeco } from "@decocms/nextjs/config";

// withDeco: the draft header rules (no-store, noindex) and Studio's dev origins.
// The image loader is the site's one-line file over its ImageUrl.
export default withDeco({
  images: { loader: "custom", loaderFile: "./src/image-loader.ts" },
});
