import { createFileRoute } from "@tanstack/react-router";
import { loadPage } from "../page.functions";

export const Route = createFileRoute("/$")({
  loader: ({ location }) => loadPage({ data: { href: location.pathname + location.searchStr } }),
  head: ({ loaderData }) => ({
    meta: loaderData?.seo   // without seo, the root route's defaults apply
      ? [{ title: loaderData.seo.title }, { name: "description", content: loaderData.seo.description }]
      : [],
  }),
  component: () => <>{Route.useLoaderData().content}</>,
  pendingComponent: () => <p>Opening page…</p>,
  errorComponent: () => <p>The page could not be loaded.</p>,
});
