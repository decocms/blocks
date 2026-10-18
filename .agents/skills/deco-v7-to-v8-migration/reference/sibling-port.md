# Porting from a sibling site

From the site migrations; the sites and what the commit hashes refer to are listed in `SKILL.md` ("Gotchas by subject").

A three-way merge from a site that is already on v8 (`SKILL.md`, "A sibling site already migrated?") brings everything that site changed, not only the migration:

- **Its own later product changes.** Read the sibling's history after its script run (`git log <run>..<v8> -- src`) and back out what came from merging its main (a cart read switched from GET to POST, an SSR prefetch skipped) unless the site being migrated has it on its own main.
- **Vendored copies of another version.** The sibling vendored its installed `@decocms/*`. Diff that version's sources with the site's (`npm pack @decocms/<pkg>@<version>`) and re-vendor what changed (commerce types, `useOffer`); keep the sibling's v8 edits on top. A sibling migrated before the bindings vendored `Image`, `NavigationProgress`, the worker entry or the draft code: take those from `@decocms/tanstack`/`@decocms/nextjs` instead of merging the copies (`framework-code.md`).
- **Content.** Saved blocks byte-identical on both sides on v7 can take the sibling's migrated version, but check each field it dropped against this site's own types: `deco check` on the site's unmodified content must list every dropped field as unknown.
- **Editor forms.** The sibling's SEO and loader types match its v7 forms, not necessarily this site's (7.6x added fields to the SEO sections, such as Structured Data and Omit variants, and offered loaders such as `RelatedProducts` in product pickers). Diff the forms against this site's own v7 schema.
- **Security headers.** Compare the site's v7 `createDecoWorkerEntry` options with the sibling's: a site that passed `securityHeaders: { "Content-Security-Policy": … }` sent an enforced CSP that replaces the default `frame-ancestors` one, and no `X-Frame-Options`. The copied edge cache must send that header, not the sibling's report-only list.
