import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

const rootRoute = createRootRoute();

const previewRouter = createRouter({
  // TanStack Router's RootRoute/Route generic inference rejects bare rootRoute
  // at the type level (works at runtime). `as any` avoids leaking the mismatch
  // into consumer sites that typecheck framework source via npm link.
  routeTree: rootRoute as any,
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

// A dedicated QueryClient for preview renders. Sections that call useQuery /
// useQueryClient at render time (e.g. commerce shelves, carousels) would
// otherwise throw "No QueryClient set" during the admin's isolated
// renderToString pass — the site's production QueryClientProvider (wired via
// createDecoRouter's `Wrap`) is not in scope on the /live/previews path.
// Retries are disabled so a preview render never hangs on a failing query;
// this is a static content render (matches __decoFBT=0), so cached data is
// not expected here.
const previewQueryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

/**
 * Default preview wrapper for admin iframe rendering.
 * Provides a TanStack Router context with memory history so components
 * that depend on router hooks (Link, useNavigate, etc.) work in previews,
 * plus a QueryClientProvider so components that call React Query hooks at
 * render time don't crash the preview.
 */
export default function PreviewProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={previewQueryClient}>
      <RouterContextProvider router={previewRouter as any}>{children}</RouterContextProvider>
    </QueryClientProvider>
  );
}
