import { createSiteSetup } from "@decocms/live/setup";
import { createAdminSetup } from "@decocms/admin/setup";

// Unlike the Vite-based tanstack-smoke fixture (which passes
// `import.meta.glob("./sections/**/*.tsx")` — a Vite-only construct not
// available under Next's webpack build), this fixture builds the same
// Vite-glob-shaped map (`"./sections/X.tsx" -> loader`) by hand.
// `createSiteSetup` strips the leading "./" and prefixes with "site/", so
// this resolves to the same `site/sections/Hero.tsx` registry key that the
// `pages-home` block below references via `__resolveType`.
//
// `blocks` here is real content (not `{}`) on purpose: this fixture exists
// to prove the whole CMS resolution pipeline — page match, section
// registry lookup, prop passthrough — renders actual content end-to-end
// under Next's real build, not just that the package compiles. A page
// block must use a `pages-` key prefix (see `getAllPages` in
// packages/live/src/cms/loader.ts) and a section must be registered
// through `registerSections` (the async-loader form) — `resolveDecoPage`'s
// resolution pipeline does not read `registerSectionsSync`'s registry.
createSiteSetup({
  sections: {
    "./sections/Hero.tsx": () => import("./sections/Hero"),
  },
  blocks: {
    "pages-home": {
      path: "/",
      sections: [{ __resolveType: "site/sections/Hero.tsx", label: "next-smoke" }],
    },
  },
});

createAdminSetup({
  meta: () => Promise.resolve({}),
  css: "",
});
