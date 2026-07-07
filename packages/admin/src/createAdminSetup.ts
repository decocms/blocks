/**
 * The admin-facing half of a site's one-call bootstrap: admin meta schema,
 * render shell config, preview wrapper, and commerce-loaders-to-invoke
 * wiring. Call alongside createSiteSetup() (@decocms/runtime/setup)
 * — the two were one function before the package split; they're separate
 * here because these four steps need admin/index.ts's setters, which
 * runtime cannot import without creating a circular dependency.
 */
import {
  setInvokeLoaders,
  setMetaData,
  setPreviewWrapper,
  setRenderShell,
} from "./admin/index";

export interface AdminSetupOptions {
  /**
   * Lazy loader for admin meta schema — only fetched when admin requests it:
   * `() => import("./server/admin/meta.gen.json").then(m => m.default)`
   */
  meta: () => Promise<any>;

  /** CSS file URL from Vite `?url` import. */
  css: string;

  /** Font URLs to preload in admin preview shell. */
  fonts?: string[];

  /** Preview wrapper component for admin preview iframe. */
  previewWrapper?: React.ComponentType<any>;

  /**
   * Commerce loaders getter — passed to `setInvokeLoaders`.
   * Use a thunk so the full map (including site-specific loaders
   * defined after createAdminSetup) is captured.
   */
  getCommerceLoaders?: () => Record<string, (props: any, request?: Request) => Promise<any>>;
}

/**
 * Bootstrap a Deco site's admin protocol — meta schema, render shell,
 * preview wrapper, commerce-loader-to-invoke wiring. Call alongside
 * createSiteSetup() (@decocms/runtime/setup).
 */
export function createAdminSetup(options: AdminSetupOptions): void {
  // 7. Admin meta schema (lazy)
  options.meta().then((data) => setMetaData(data));

  // 8. Render shell
  setRenderShell({
    css: options.css,
    fonts: options.fonts,
  });

  // 9. Preview wrapper
  if (options.previewWrapper) {
    setPreviewWrapper(options.previewWrapper);
  }

  // 10. Commerce loaders → invoke
  if (options.getCommerceLoaders) {
    setInvokeLoaders(options.getCommerceLoaders);
  }
}
