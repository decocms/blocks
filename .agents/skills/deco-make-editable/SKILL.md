---
name: deco-make-editable
description: "@decocms/blocks 8: turn a hardcoded site, or a Figma design, into blocks that people edit in deco Studio, without changing how the site looks. Covers the inventory of content vs interface, the three content shapes (global blocks read by name, composed pages of type page, collections read with client.list), the foo/fooPt bilingual field convention, seeding .deco/blocks from the existing code and sending it with deco push --draft and deco check --draft, implementing sections from a Figma file with the Figma MCP tools, pixel-parity checks with Playwright, accessibility and functional checks, and working in small PRs. Load it when asked to make a site, page, menu, footer or landing editable in Studio, to move hardcoded text into the CMS, to handle two languages in CMS content, or to build a Figma design as editable sections on a v8 site."
---

# Make a site editable in Studio

The goal is not "move strings into JSON". It is two things at once:

1. Someone who is not a developer opens Studio, changes a text, a link or the
   order of sections, publishes, and the site changes.
2. The site renders exactly as it did before the conversion.

Every step serves one of those two halves. The same method works when the
starting point is a Figma file instead of a hardcoded site: build the sections
from the design, then seed them with the design's content.

This skill is about method. For the v8 mechanics it relies on, load the skill
that owns them:

- `deco-site-authoring`: writing sections, pages and loaders.
- `deco-cms-schema`: how a `Props` type becomes the Studio form (JSDoc tags,
  widgets, shapes that break the form).
- `deco-site-workflow`: the `deco` CLI, where content lives, drafts and
  publishing, and what to check when Studio cannot see the site.
- `deco-tanstack-site` or `deco-nextjs-site`: the routes and the worker.

## When to load what

| Reference | Load it when |
|---|---|
| [`references/inventory.md`](./references/inventory.md) | Starting: deciding what goes to the CMS, what stays in code, and the order of PRs |
| [`references/content-shapes.md`](./references/content-shapes.md) | Choosing between a global block, a composed page and a collection, and wiring each one |
| [`references/i18n-fields.md`](./references/i18n-fields.md) | The site has two languages and the content must be edited in both |
| [`references/seeding-content.md`](./references/seeding-content.md) | Writing the first `.deco/blocks` files from the current code, sending them as a draft, and the order of publish and deploy |
| [`references/from-figma.md`](./references/from-figma.md) | The starting point is a Figma file: mapping frames to sections, tokens, assets |
| [`references/pixel-parity.md`](./references/pixel-parity.md) | Proving a PR changes nothing visible: HTML diff, screenshot diff, Figma comparison, live edit |
| [`references/a11y-and-e2e.md`](./references/a11y-and-e2e.md) | Before calling a section or a page done: accessibility and functional checks |

## The loop, per content area

Work in small PRs, one content area at a time (menu, then home, then
landings). Each PR goes through the same loop:

1. **Inventory** the area: which texts, links and lists are content.
2. **Shape** each piece: global block, composed page or collection.
3. **Type** the props and add the block to the block map (`.deco/index.ts`, or
   `.deco/index.tsx` when it holds JSX). Run `deco schema`.
4. **Seed** `.deco/blocks` from the current code, never by retyping.
5. **Check** with `deco check` (local content) or `deco push --draft=<name>`
   then `deco check --draft=<name>` (a hosted site).
6. **Prove parity**: the page on the branch and on `main` render the same
   HTML and the same pixels, at desktop and mobile widths, in every language.
7. **Live edit**: change the content and see the change land on the right
   page and language only.

A PR that is not pixel-identical to `main` does not merge. That rule is what
lets a conversion run for weeks without anyone noticing it on the live site.

## v8 facts this skill relies on

These are true of the packages in this repo and change how the v7 version of
this method worked.

- **Studio lists only what the block map lists.** A block type exists because
  `.deco/index.ts` exports a function under that key. Components that are not
  in the map never show up in Studio's section picker, so there is no folder
  to keep clean.
- **The form comes from the function's input type.** `deco schema` reads the
  first parameter's type of each function in the map and writes
  `.deco/schema.gen.json`. A function that returns JSX or a
  `{ component, props }` descriptor is a section; one that returns its own
  input is content (or a page, when the type extends `Route`).
- **Block functions get only their saved input.** Anything that depends on the
  request (the language, the path) is added by the site's code that renders
  the result, not by the block function.
- **Results are read-only.** A client runs each block function once per
  distinct input and hands the same object to every place that uses it. Copy
  before you change a result (the `localize` helper in
  [i18n-fields.md](./references/i18n-fields.md) builds a new object).
- **There is no locale in the CMS.** Two languages are a site convention (see
  [i18n-fields.md](./references/i18n-fields.md)).
- **The CLI has no asset upload command.** How images get to the site is
  covered in `deco-images-media`.

## Rules for this skill

- Never retype content. Extract it from the code with a script.
- No fallback copy of the content in code. A constant fallback becomes a
  second source of truth that drifts from what editors see.
- Do not publish a draft (`deco publish`) without the site owner's explicit
  OK for that publish.
- Anything specific to one store goes in that store's own notes, not here.
