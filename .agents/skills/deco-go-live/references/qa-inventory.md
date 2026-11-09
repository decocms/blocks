# QA inventory: what this site actually has

A QA checklist is only useful when it is scoped to the site: no rows for
features it doesn't have, and a row for every block, route and interaction it
does have. Build the inventory first, then fill
[qa-checklist-template.md](./qa-checklist-template.md) from it.

Run everything from the site root (the folder that holds `.deco/`). Pull
production content first so `.deco/blocks` matches what is live:

```bash
deco pull          # production into .deco/blocks (see deco-site-workflow)
```

## 1. Health: schema and content

```bash
deco schema --check    # .deco/schema.gen.json is up to date with the block types
deco check             # production content against the schema: 0 errors
```

Every error here is a page that renders wrong. Fix them before QA starts, or
list them as known issues.

## 2. Block types (the block map)

`.deco/index.ts` (or `.tsx`) exports the block map, the types `deco schema` turns into
Studio forms. Each key is a block type editors can pick.

```bash
sed -n '1,200p' .deco/index.ts*                      # read the map and where each entry comes from
```

Then count which types the content really uses. Types in the map that no
saved block uses need no QA row; types used everywhere need one per place.

```bash
jq -r '.. | objects | .["__resolveType"]? // empty' .deco/blocks/*.json | sort | uniq -c | sort -rn
```

## 3. Pages and routes

Each saved page block has a `path` (a literal, `:name` segments, or a
trailing `*`). The site's catch-all route matches a URL against them with
`matchRoute`; other routes are the framework's own (TanStack `src/routes/`,
Next.js `app/`).

```bash
jq -r 'select(.path) | "\(.path)\t\(input_filename | split("/") | last)"' .deco/blocks/*.json | sort
ls src/routes 2>/dev/null; find app -name 'page.tsx' 2>/dev/null
```

For each template, pick one real URL (a real product slug, a real category)
for the checklist. Add the page types every store has even if the template is
generic: home, listing, product, search, not found, institutional.

## 4. Redirects, experiments, campaigns

```bash
jq '.redirects | length' .deco/blocks/Redirects.json 2>/dev/null     # rules to sweep
jq . .deco/blocks/experiments.json .deco/blocks/campaigns.json 2>/dev/null   # the saved blocks every test and campaign rule reads
grep -rl '"multivariate"' .deco/blocks | head                          # pages with variants
```

Each running test or campaign needs a row per side: force each with a Studio
preview link (`__test`, `__campaign` on a draft link). **deco-variants** has
the details.

## 5. Interactive components

```bash
# client state and effects
grep -rlE "useState|useEffect|useReducer|useSyncExternalStore" src --include='*.tsx'
# event handlers
grep -rlE "onClick|onChange|onSubmit|addEventListener" src --include='*.tsx'
# direct DOM access (fragile under React)
grep -rlE "document\.(getElementById|querySelector)" src --include='*.tsx' --include='*.ts'
# inline scripts (test by SPA click, not only F5)
grep -rlE "useScript\(|useScriptAsDataURI\(|inlineScript\(|<script" src
```

Group the hits by UI: header (menu, search, minicart), sliders, product page
(gallery, variant picker, buy button, shipping estimate), cart, listing
(filters, sort, pagination), modals and drawers, footer (newsletter).

## 6. Server functions and loaders

Server functions replace v7's `/deco/invoke`. Each one is a request the
browser makes and a thing that can be cancelled by navigation.

```bash
grep -rn "createServerFn" src | cut -d: -f1 | sort | uniq -c       # TanStack
grep -rln '"use server"' src app 2>/dev/null                         # Next.js
```

Mark the ones that write (cart, newsletter, login): they need a "write then
navigate at once" row ([react-spa.md](./react-spa.md#server-functions-cancelled-on-navigation)).

## 7. Integrations

```bash
jq -r '.dependencies // {} | keys[]' package.json | grep -E "^@decocms/"     # apps-vtex, apps-shopify, …
grep -rliE "dataLayer|sendEvent|DECO\.events" src | head                     # analytics
grep -rliE "<vendor names you know of: reviews, chat, search, consent>" src
```

Each integration gets a row: it loads, it receives events, and it fails
without breaking the page.

## 8. Old-site behaviors

If the site was ported, diff the inventory against the old repo too: a
feature that exists there and has no row here was either dropped (get
sign-off) or forgotten ([process.md](./process.md#inventory-of-what-was-not-ported)).

## Output

Write the inventory down as a short table before the checklist: block type →
pages that use it → component file. That table is what makes each checklist row
point at a real file and a real URL.
