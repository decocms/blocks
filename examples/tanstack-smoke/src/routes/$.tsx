import { createFileRoute } from "@tanstack/react-router";
import { cmsRouteConfig } from "@decocms/tanstack";

export const Route = createFileRoute("/$")(
  cmsRouteConfig({ siteName: "tanstack-smoke-fixture", defaultTitle: "tanstack-smoke-fixture" }),
);
