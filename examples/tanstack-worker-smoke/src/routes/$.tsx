import { Suspense } from "react";
import { Await, createFileRoute } from "@tanstack/react-router";
import ProductHero from "../ProductHero";
import PromoBanner from "../PromoBanner";
import type { BlockDescriptor } from "../model";
import { loadPage } from "../page.functions";

// Maps each descriptor to its component. Add a case per block type.
function View({ block }: { block: BlockDescriptor | BlockDescriptor[] }) {
  if (Array.isArray(block)) return block.map((item, index) => <View key={index} block={item} />);   // the chosen variant of the whole list
  switch (block.component) {
    case "promo-banner":
      return <PromoBanner {...block.props} />;
    case "product-hero":
      return <ProductHero {...block.props} />;
  }
}

export const Route = createFileRoute("/$")({
  loader: ({ location }) => loadPage({ data: { href: location.pathname + location.searchStr } }),
  head: ({ loaderData }) => ({
    meta: loaderData?.seo   // without seo, the root route's defaults apply
      ? [{ title: loaderData.seo.title }, { name: "description", content: loaderData.seo.description }]
      : [],
  }),
  component: Page,
  pendingComponent: () => <p>Opening page…</p>,
  errorComponent: () => <p>The page could not be loaded.</p>,
});

function Page() {
  const page = Route.useLoaderData();
  return (
    <main>
      {page.blocks.map((block) => (
        <Suspense key={block.key} fallback={<p>Loading…</p>}>
          <Await promise={block.value}>
            {({ value, failed }) => {
              if (failed) return <p role="status">This content is temporarily unavailable.</p>;
              return value ? <View block={value} /> : null;   // undefined when an editor hid the block
            }}
          </Await>
        </Suspense>
      ))}
    </main>
  );
}
