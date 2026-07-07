import { createRootRoute, Outlet } from "@tanstack/react-router";
import { DecoRootLayout } from "@decocms/tanstack";

export const Route = createRootRoute({
  component: () => (
    <DecoRootLayout siteName="tanstack-smoke-fixture">
      <Outlet />
    </DecoRootLayout>
  ),
});
