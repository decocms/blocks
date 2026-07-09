import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createDecoRouter } from "@decocms/tanstack";
import { routeTree } from "./routeTree.gen";
import "./setup";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000 } },
});

export function getRouter() {
  return createDecoRouter({
    routeTree,
    context: { queryClient },
    Wrap: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
