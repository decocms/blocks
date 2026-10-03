// upstream-clients.mdx › the `.deco/index.tsx (excerpt)` block map entry.
import type { Blocks } from "@decocms/blocks";
import type { ProductHit } from "./acme-search";
import { search } from "./search";

export function ProductShelf({ title, products }: { title: string; products: ProductHit[] }) {
  return (
    <section>
      <h2>{title}</h2>
      {products.map((p) => <a key={p.sku} href={p.url}>{p.name}</a>)}
    </section>
  );
}

export default {
"product-shelf": async ({ title, query }: { title: string; query: string }) => {
  const products = await search.search(query, 8);
  return <ProductShelf title={title} products={products} />;
},
} satisfies Blocks;
