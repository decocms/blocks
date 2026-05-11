/**
 * @decocms/start/next/client — client-safe surface.
 *
 * Imports here MUST NOT transitively reach node:async_hooks, node:fs,
 * or any other Node-only module. Validated by scripts/check-tier-boundaries.ts
 * (added in Phase 8).
 *
 * `useHydrated` is intentionally omitted from the Next.js client surface
 * because it depends on `@tanstack/react-router`, which would pull TanStack
 * into Next.js client bundles. Next.js consumers can implement an equivalent
 * using `useEffect`/`useState` if hydration gating is needed.
 */
export { useDevice } from "../core/sdk/useDevice";
export { signal } from "../core/sdk/signal";
