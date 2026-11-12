/**
 * Inline-script source defining `isTrustedEditorOrigin(origin)`: whether a
 * postMessage sender may drive the storefront (e.g. `editor::inject`, which
 * evals the script it carries). The deco admin and Studio, or the page itself.
 *
 * A source string, not a function, because every consumer is a bootstrap
 * `<script>` that runs before any bundle loads.
 */
export const EDITOR_ORIGIN_CHECK_JS = `
  var TRUSTED_EDITOR_ORIGINS = ["https://deco.cx", "https://admin.deco.cx", "https://play.deco.cx", "https://decocms.com", "https://studio.decocms.com"];
  function isTrustedEditorOrigin(origin) {
    return TRUSTED_EDITOR_ORIGINS.indexOf(origin) !== -1 ||
      (origin.startsWith("https://") && origin.endsWith(".deco.cx")) ||
      (origin.startsWith("https://") && origin.endsWith(".decocms.com")) ||
      origin === window.location.origin;
  }
`;
