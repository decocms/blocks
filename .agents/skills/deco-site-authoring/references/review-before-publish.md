# Review before publish

Run this before `deco push`, before opening a PR, and again before `deco publish`. Read
the diff (`git diff` for code, `deco diff` for content) and go through each item. The
command details are in the `deco-site-workflow` skill.

## 1. The schema matches the code

- Run `deco schema`. It must print no errors. With an error it writes nothing, and
  Studio keeps the old forms.
- In CI, `deco schema --check` fails when `.deco/schema.gen.json` is out of date.
  Commit the regenerated file with the code change.
- Read every warning: `props are typed any` (empty form) and `returns any` (offered for
  no field) are bugs.

## 2. Existing content still fits

This is the check for breaking changes: a renamed or removed prop, a changed loader
return type, a removed block map key.

- `deco check` with no flag checks **production** content (when the site has
  `DECO_SITE`) against your **local** `.deco/schema.gen.json`. That is exactly the
  question "does my code change break pages already live?". Run it after `deco schema`.
- `deco check --draft=<name>` checks a draft's content. `--revision=<id>` checks a
  published release.
- With no `DECO_SITE` anywhere, `deco check` checks the files in `.deco/blocks`.
- Exit code 1 means at least one error: an unknown block type, a field no type
  declares (`unknown field`), a block that does not fit its field, two pages or
  redirects matching the same URLs. Warnings do not fail it, but read them: a replaced
  built-in, a `redirect` block that is not routed.

If a prop must change shape, keep the old field working until content is migrated, or
migrate the content in the same change and push it as a draft.

## 3. Content edits are what you meant

- `deco diff` shows what `.deco/blocks` changes against what you pulled.
  `deco diff --draft=<name>` compares against a draft.
- `deco push --draft=<name>` saves the changed blocks into a draft as one change and
  prints its preview link. Open every page you touched through that link, at mobile and
  desktop widths.
- Publish only with an explicit go-ahead: `deco publish --draft=<name>` prints the
  changes first, then makes the draft live.

## 4. Hardcoded text and styles

- Text a merchant would change (titles, labels, banners, links) is a prop, not a string
  in the component. Fixed interface text (aria labels, "Add to cart" when the site has
  no i18n) can stay in code.
- Styles use the site's design tokens (Tailwind theme values, CSS variables), not raw
  values that have a token.
- A prop that only switches layout or spacing earns its place only if editors need it.

## 5. Sections

- Props are typed with a named interface, and the block map uses `satisfies Blocks`.
- The section renders nothing for `undefined` and has a failed state on routes that
  stream sections.
- Interactive parts are small `"use client"` components. No hooks in an element-mode
  section itself.
- In descriptor mode, the new section has its union member, its block map key and its
  `case` in the route's view.
- The route's Suspense fallback for the section is a skeleton of the right size.

## 6. Loaders

- Each loader asks the upstream for only what the sections show.
- No loader mutates a result it got from another block.
- Blocks that need the same data resolve the same loader with identical inputs, so the
  request makes one call (see [loaders.md](./loaders.md)).
- A loader that can fail has a decision: return empty, render nothing, or throw.
- Upstream calls go through an `@decocms/apps-*` client or `createInstrumentedFetch`.
- Expensive data a section may not use is a `Lazy<T>` prop.

## 7. Secrets

- No token, API key or password in code, in `.deco/blocks`, or in a prop default.
  Content holds no secrets on v8. Secrets live in the deploy platform and reach code
  when the client is created.
- `.env` and `.dev.vars` are not committed.

## 8. Dead code

- Every new file is imported. Every new block map key is used by content or meant for
  editors.
- A removed block map key has no content left that uses it (`deco check` reports the
  unknown type).
- No leftover v7 or Fresh imports (`apps/`, `$fresh`, `islands/`,
  `@decocms/blocks/cms`).

## 9. Order of release

Code that adds or changes a block must be deployed, and its schema pushed, before
content that uses it is published. Otherwise production resolves a type it does not
have (`UNKNOWN_BLOCK`). The deploy order is in the `deco-site-workflow` skill.
