# Render location: server work that is slow, wasted, or in the wrong place

Load when: TTFB is seconds while the HTML is small; a page resolves data it never
renders; you do not know which block is slow; the site carries thousands of redirects.

Lighthouse cannot see any of this. It shows up as one TTFB number with no audit
pointing at it. The browser timeline is clean; the server did the work.

## 1. Attribute the wait before you change anything

Time every block function for one run. The block map is a plain object of functions,
so wrap it where you create the CMS (not in `.deco/index.ts`, which `deco schema` reads):

```ts
// src/cms.ts — temporary, for a local or preview run
import { createCMS, type Blocks } from "@decocms/blocks";
import blocks from "../.deco";

const timed = (map: Blocks): Blocks =>
  Object.fromEntries(
    Object.entries(map).map(([name, fn]) => [
      name,
      async (input: unknown) => {
        const t0 = performance.now();
        try {
          return await fn(input);
        } finally {
          console.log(`[block] ${Math.round(performance.now() - t0)}ms ${name}`);
        }
      },
    ]),
  );

export const cms = createCMS({ blocks: timed(blocks), site: "my-store" });
```

The wrapper times only the function's own run: the resolver resolves a block's inputs
before it calls the function, so a nested block logs its own line. A block the client
already ran for the same inputs in this request logs nothing (it is a memo hit; see
[`request-dedupe.md`](./request-dedupe.md)). Sort the lines by ms. The ranking matters,
not the absolute numbers.

In production, the same data exists as telemetry spans: when a trace is sampled, every
block run becomes a span named after its block type, with `deco.block.type`. Sampling
is off by default. It needs a telemetry destination (a `token` or a `telemetry.endpoint`
on `createCMS`), the cap `createCMS({ telemetry: { limits: { traceSampleRate } } })`
(default 0), and `telemetry.traceSampleRate` in the saved `CMS` block (default 0).

## 2. A prop resolved eagerly and then thrown away

The resolver resolves every `__resolveType` in a block's inputs before it calls the
function, including branches the section will not render: a 404 fallback, a tab that
is closed, a modal, the hidden side of a flag.

Measured on a v7 product page: the "not found" fallback held a shelf whose products came
from a full-text search. It cost **1.7 s on every product page**, and the result was
discarded. v8 resolves inputs the same way, so the same content shape costs the same.

The fix in v8 is the built-in `lazy` block. Type the prop as `Lazy<T>` and call it only
on the branch that renders it:

```ts
import type { Lazy } from "@decocms/blocks";

interface Props {
  product: Product | null;
  notFoundShelf: Lazy<Product[]>; // content: { "__resolveType": "lazy", "value": { …the loader… } }
}

export async function productPage({ product, notFoundShelf }: Props) {
  if (product) return { component: "pdp", props: { product } };
  return { component: "not-found", props: { shelf: await notFoundShelf() } };
}
```

A `Lazy<T>` value resolves when called, at most once, with the same client. `deco schema`
turns a `Lazy<T>` field into a `lazy` block whose `value` is a `T`. `deco check` then
rejects content that puts a plain value in that field, and a `lazy` block in a field that
is not `Lazy<T>`, so the content has to change with the type. See `deco-site-authoring`
for writing lazy props with Suspense and skeletons.

Two more shapes with the same cost:

- **Blocks that render nothing** (theme fonts, an SEO section's JSON-LD input) still run
  their data blocks. Wrap the data argument in `lazy` in content so nothing is fetched
  until it is used.
- **Variants.** The built-in `multivariate` resolves rules in order, stops at the first
  true one, and runs only that variant's `value`, which is a `Lazy`. A variant saved
  without the `lazy` wrapper (`deco check` flags it) resolves eagerly when it comes
  before the winner. Run `deco check` on migrated content.

## 3. Streamed blocks vs awaited blocks

In the example page route, each section block is its own promise, and only the SEO
block is awaited. TTFB is then routing plus the SEO block, and the slow sections stream
in afterwards. Check what your site does:

| Your route | TTFB is | Use it when |
|---|---|---|
| Awaits only routing and SEO | the slower of the two | the default |
| Awaits every block | the slowest block | blocks read only in-memory content, or response headers depend on how blocks resolved |
| Awaits one block before starting the others | that block plus the rest | never: start every block first, then await |

The SEO block often needs the same product the main section needs. If both name the same
loader with the same inputs, the client runs it once and both get the result. If they
differ in one prop (a `count`, an extra facet), it runs twice. See `request-dedupe.md`.

Streaming has one trap on TanStack Start: a block promise still pending when the
document streams can reach the browser without settling, so the section never hydrates.
The check and the fix are in [`hydration.md`](./hydration.md).

## 4. A large Redirects block is paid on every request

`createDecoWorker` checks the CMS redirects on every non-asset `GET` that is not a
server-function call. The check runs before `routes` and before your `pageCache`, so a
cache hit pays it too. Each check builds a new client, reads the `redirects` block
(a fresh copy of its rules), and `matchRoute` compiles the rules into a trie. The trie is
cached per array, and the array is new for each client. The page route reads the redirects
again with its own client, so a rendered page pays it twice.

Measured on a laptop with Bun, against this repo's `createCMS` and `matchRoute`, per
client (`redirects()` plus one `matchRoute`):

| Rules in the block | Cost per client |
|---|---|
| 1,000 | ~3 ms |
| 5,000 | ~13 ms |
| 20,000 | ~45 ms |
| 50,000 | ~120 ms |

A Worker isolate is slower than a laptop. If a migration folded a large redirect CSV into
`Redirects`, keep the editor-managed rules there and move the long tail to a point lookup:
a Workers KV namespace read by key in your `routes` handler (one `get` per request, never
`list`). The memory side of this is in [`worker-memory.md`](./worker-memory.md).

## 5. Bots get the same HTML as people

v8 has no deferred sections, so crawlers and browsers get the same document. Check what
that document carries for crawlers. One listing page emitted JSON-LD of type `"Products"`,
which does not exist in schema.org, so no crawler read it. It was **2.75 MB per listing
page**. A listing's JSON-LD is an `ItemList` of `ListItem` with `url` and `position`; the
full `Product` belongs on the product page. That change took the block from 2,474,206 to
6,198 bytes. More in [`payload-trim.md`](./payload-trim.md).

## Rules

- Small wire plus long wait means server work. Large wire plus short wait means payload.
- Do not move rendering to the client to win a number. Above-the-fold content and
  anything a crawler must read stays on the server. This file is about work that is
  discarded or repeated.
- Check one URL two or three times. A swing from 0.2 s to 3.6 s is a cold isolate or a
  cache miss, not the page.
