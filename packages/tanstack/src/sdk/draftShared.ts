/**
 * Client-bundle-safe constants shared by the server-side draft binding
 * (`./draft`, which imports the server-only `@decocms/blocks/cms`) and the
 * isomorphic preview-badge indicator (`../hooks/DraftPreviewIndicator`, which
 * must stay client-safe). Kept in their own module so the indicator never has
 * to import `./draft` and drag `node:async_hooks` into the browser bundle.
 */

/** RequestContext bag key the active draft pointer is stashed under during SSR. */
export const DRAFT_POINTER_BAG_KEY = "deco:draftPointer";

/**
 * Global the SSR pass publishes the pointer on, so the client's hydration
 * render reads the same value (RequestContext is a no-op stub in the browser).
 */
export const DRAFT_POINTER_GLOBAL = "__DECO_DRAFT_POINTER__";
