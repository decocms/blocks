# Lazy blocks, streaming and skeletons

Two different tools answer "don't make the page wait for this":

- The **`lazy` built-in** skips work on the server: a prop typed `Lazy<T>` is a function
  the block calls only if it needs the value.
- **One promise per section** streams the page: the page loader resolves each section on
  its own, and the route shows a fallback in a Suspense boundary until that section is
  ready.

v8 has no async rendering of the v7 kind. There is no `Rendering/Lazy.tsx` wrapper in
content, no `LoadingFallback` export picked up by the framework, and no section that
waits for the viewport before it loads. The migration script unwraps v7's wrappers into
plain sections.

## The `lazy` built-in

```ts
import type { Lazy } from "@decocms/blocks";

export async function productCard({
  title,
  showProduct,
  product,
}: {
  title: string;
  showProduct: boolean;
  product: Lazy<Product>;
}) {
  if (!showProduct) return <Title text={title} />; // the loader never runs
  const item = await product(); // the loader runs here
  return <Card title={title} product={item} />;
}
```

In content, the field holds a `lazy` block around the loader:

```json
{
  "__resolveType": "product-card",
  "title": "Summer collection",
  "showProduct": true,
  "product": {
    "__resolveType": "lazy",
    "value": { "__resolveType": "product-by-slug", "slug": "summer-shirt" }
  }
}
```

How it behaves:

- The resolver does not resolve `value` first. It hands the block a memoized
  `() => Promise<T>` instead.
- The value resolves the first time the function is called, and only once. A second
  call returns the same result.
- If the value fails, the call rejects, and the block decides what to do. If the block
  lets the error escape, the block fails with the inner error's code and path.
- A lazy value that is never called never runs, and never rejects unhandled.
- `value` can be any JSON, not only a block. Saved block references inside it expand
  when it is called.

Schema and checks:

- `deco schema` turns a `Lazy<T>` prop into a field that holds a `lazy` block whose
  `value` has the form of `T`. `Lazy<T>[]` is a list of them.
- `deco check` reports `this field is Lazy<T>: wrap the value in a lazy block` for a
  plain value in such a field, and `a lazy block only fits a Lazy<T> field` for a `lazy`
  block anywhere else. A `lazy` block cannot sit directly in a page's `sections`.
- The built-in `multivariate` stores each variant's `value` as a `lazy` block, so only
  the chosen variant runs. `deco check` reports `a variant's value must be a lazy block`
  otherwise.
- A matcher can take an inner rule as `Lazy<boolean>` and skip it:
  `async ({ a, b }: { a: boolean; b: Lazy<boolean> }) => a && (await b())`.

Use `Lazy<T>` when the block may not need the data: a toggle, a tab that is closed by
default, a fallback source, an expensive rule. It does not move work to the browser or
delay it until scroll. A block that always calls its lazy prop gains nothing from it.

## One promise per section

The page loader in the examples (`src/open-page.server.ts`) reads the page with
`{ run: false }`, then starts one `client.resolve(section)` per section and returns the
promises without awaiting them:

```ts
const blocks = sections.map((block, index) => ({
  key: `${href}:${index}`,
  value: c.resolve(block).then(([value, error]) => {
    if (error) console.error(error);
    return { value: value ?? undefined, failed: error !== null };
  }),
}));
```

Each entry settles to `{ value, failed }` and never rejects, so one slow or failing
section does not hold or break the others. The route renders each one in its own
boundary. On TanStack Start without RSC:

```tsx
<Suspense key={block.key} fallback={<SectionSkeleton />}>
  <Await promise={block.value}>
    {({ value, failed }) => {
      if (failed) return <p role="status">This content is temporarily unavailable.</p>;
      return value ? <View block={value} /> : null; // undefined: an editor hid it
    }}
  </Await>
</Suspense>
```

With TanStack RSC (`examples/tanstack-rsc-smoke`), an async server component awaits
the promise inside the same `Suspense`. The Next.js examples resolve the whole page in
one call instead, so nothing streams per section and one failing block fails the page.
A Next.js site that wants per-section streaming applies the same split in its page
loader. The wiring is in the `deco-tanstack-site` and `deco-nextjs-site` skills.

Three states to render, every time:

| State | Cause | Render |
|---|---|---|
| Pending | The section's loaders are still running | The Suspense fallback |
| `failed: true` | A block in the section threw | A small, quiet message, or nothing for decoration |
| `value === undefined` | A rule hid the section | Nothing |

Two caveats from migrated sites (details in the `deco-v7-to-v8-migration` skill,
`rendering.md`):

- After changing the page setup, check in the browser that every streamed section
  hydrates (its handlers and effects run). One TanStack Start release left streamed
  sections with server markup that never hydrated.
- A page whose blocks only read in-memory content can await them, so every section is
  in the first HTML chunk. Stop awaiting a block once it fetches upstream.

## Skeletons

The fallback is shown in the server's first HTML and then replaced in place. A
skeleton that is the wrong size moves the page when the section arrives (CLS).

- **Match the box.** Same container, padding, gaps and aspect ratios as the real
  section, at each breakpoint. Height matters more than detail.
- **Pure markup.** CSS only (a pulse animation is fine). No hooks, no data, no props
  from the loader. It renders before any data exists.
- **Represent the content.** A shelf skeleton shows a title bar and the number of cards
  the real shelf shows per breakpoint (for example two on mobile, four on desktop,
  hiding the rest with responsive classes).
- **Reuse a card skeleton.** Most shelves and grids repeat a product card. Build one
  `CardSkeleton` that mirrors the real card (image, name in two lines, price block,
  button) and use it everywhere.
- **Pick the skeleton per section type.** `{ run: false }` already gives the page
  loader each section's `__resolveType` (saved references are expanded, so a reference
  to a saved block shows the saved block's type). The page loader can return it next to
  `key` and `value`, and the route can map it to a skeleton, with one generic fallback
  for the rest.
- **Above the fold.** The first sections (header, hero, product summary) are what the
  user sees first. Keep their loaders fast, or await them, rather than showing a
  skeleton where the main content should be.
