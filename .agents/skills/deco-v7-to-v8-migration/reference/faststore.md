# FastStore storefronts that aren't ejected

Learned on a VTEX FastStore storefront (`@faststore/cli` 4.x, Next.js 16 Pages Router, private) whose v7 integration monkey-patched FastStore's content requests. FastStore owns the Next.js app (it generates it into `.faststore/` at build) and only compiles some of the store's folders, so there is no place for a framework guide's `createCMS` page. v8 keeps the same seam; only what sits behind it changes. The patches are site-owned glue: say so in the code and the README.

## The seam

- **Vendored runtime.** FastStore won't compile `@decocms/blocks` or `.deco/index.ts` from the store, so bundle them (esbuild, CommonJS) into a file under a folder FastStore copies (e.g. `src/server/vendor/deco-cms.cjs`), exporting `createCMS`, `parseDraftPointer` and the block map. Build it in `dev`, `test` and `build`, commit it, and build the committed copy from the **published** package: a bundle built from a linked checkout ships unpublished code. Say in the PR which version it was built from.
- **Content module.** Bundle what `deco content` writes (the blocks, revision and alias table) as JSON next to the runtime, and import it statically so the server build traces it. Don't read `.deco/` from disk at runtime: FastStore's deploy doesn't ship it.
- **Content client patch.** Patch the VTEX Content Platform client FastStore's content service calls (`@vtex/client-cp`) so it answers from `cms.forRelease()` / `cms.forDraft(pointer)`, in FastStore's `{ $componentKey, data, name }` section shape. Section blocks return a descriptor (`{ component, props }`) and FastStore renders the component.
- **Schema-derived defaults by block map, not by name.** A rule that reads a section's schema (a `default` that forces server rendering, say) must map `deco schema`'s `base64(<block name>)@Props` keys to sections through the block map's registrations. Parsing a v7 alias (`site/sections/X.tsx`) works only until the aliases go, and then every section silently changes behavior.

## Drafts on Pages Router SSG pages

FastStore's CMS pages are SSG and its CLI forbids `middleware`/`proxy` and `/api` routes, so the only point where a request can turn a static page into a per-request `getStaticProps` is Next's `tryGetPreviewData` (a non-`false` return is draft mode: no SSG cache, `Cache-Control: private, no-cache, no-store`, the value as `context.previewData`).

- **Patch the compiled runtimes, not `next/dist/server`.** Next 16 serves pages from `next/dist/compiled/next-server/pages.runtime.{dev,prod}.js`, and each inlines its own `tryGetPreviewData`. Replacing `next/dist/server/api-utils/node/try-get-preview-data` in `require.cache` reaches neither, so drafts never run, in dev or production. Add one statement after the function's per-request memo in both runtimes (webpack builds; FastStore builds with `--webpack`, so the turbo runtimes are unused) that calls a global hook and returns its answer unless it's `undefined`. A `patch-package` file of a minified runtime is hundreds of KB; an idempotent install/build script that fails when the anchor is missing is reviewable. Re-check it on every Next upgrade.
- **The hook.** Answer synchronously (Next calls it twice per request, from the route's `prepare` and from the renderer, so memoize on the request). Only a `?__draft=` or draft cookie that `parseDraftPointer` accepts is a signal: junk on a production host must not switch a page to per-request rendering. `cms.draftPointer`/`cms.draftCookie` are async, so return a token as preview data, let the content patch await the CMS's answer for it, and remember hosts the CMS refused so they go back to the SSG cache.
- **`x-nextjs-cache: HIT` is no evidence.** Next stamps it on draft-mode responses too. The draft ran when the response is `Cache-Control: private, no-cache, no-store, …` and shows the draft's content.
- **Password-protected preview domains.** FastStore protects `*.vtex.app` with a password gate that runs before the page. A store that patched it to let the Studio preview through must read the draft cookie (`__deco_draft`, the same name in v7 and v8), and accept only a value shaped like a pointer, never any `?__draft=`.
- **Prove drafts end to end; parity can't.** If the v7 draft path was dead (a `require.cache` patch is), the v7 baseline recorded the published page for the draft cases and a dead v8 path passes the compare. Probe the dev server and a production build (`next start`) by hand: `?__draft=<pointer>` on an allowed host shows the draft and sets the cookie; the cookie alone keeps the next page in the draft; a host outside `preview.hosts` and `?__draft=<junk>` get the published page; `?__draft=off` expires the cookie. Then let the draft cases differ from the baseline and list that for approval.

## Preview hosts and draft sources

- `preview.hosts` in `CMS.json` must list the dev host (`localhost`) as well as the store's hosts, within the code cap in `createCMS({ preview })`. v8 ignores v7's `DECO_ALLOWED_PREVIEW_HOSTS`: remove it from env files and harness env too.
- Drafts need no site loader: `cms.forDraft` fetches the pointer itself, only from v7's preview API domains (`*.decocms.com` and the loopback hosts by default; `createCMS({ preview: { draftHosts } })` replaces the list. The SDK reads no environment variable, so v7's `DECO_PREVIEW_API_DOMAINS` is read by the site, if at all, and passed in). Delete any draft-fetching loader the site kept from v7.
- If the site keeps v7's policy that a draft that fails to load falls back to the release, write that down: the docs say a failed draft is an error.

## Content imported from FastStore's CMS

- Pages imported from FastStore's Headless CMS carry FastStore's settings (`__settings`) next to the SEO object the editor's form edits (`seo`). Merge the form's `seo` over the imported one, or an SEO edit never renders.
- Don't route on undeclared `__`-prefixed metadata (`__cms.contentType`). The docs say the site editor keeps only declared fields, and whether `_`-keys survive a save isn't documented. Encode what routing needs in a declared field (the template's synthetic `path`, say) or declare it.
- The store's build runs `deco check`, so an importer that writes content check rejects breaks the next deploy. Make the importer apply the same cleanup rules as the migration's content commit, and run `deco check` at its end.

## Saved-block names that differ only by letter case

A case-insensitive disk (macOS) checks out one of the two files, so v7 silently bundled one of them on macOS while Linux had both. Before migrating, find which one content references (grep every saved block for both names), compare the two, and keep the referenced one; record the decision in its own commit. Make the build fail on such a pair, reading the git index too (the disk can't show it). v8's write path refuses a new name that differs from an existing one only by case, but `deco content` and `deco check` don't flag a pair that is already there.

## Global sections with per-URL matchers

v7 resolved a store-wide "global sections" list per request, so a matcher in it could show a section on some URLs only. In v8 a matcher reads the request only through the site's own request-scoped storage (`/next/blocks#reading-the-request`), and FastStore fetches global sections apart from the page, for SSG pages at build time. An adapter that resolves the list once per revision drops per-URL matching. If content uses it, keep it (resolve the list per page path, passing the path to the matcher through the site's storage); if it doesn't, list the loss for the product owner anyway, since editors could rely on it.
