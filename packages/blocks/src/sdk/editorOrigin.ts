/**
 * Inline-script source defining `isTrustedEditorOrigin(origin)`: whether a
 * postMessage sender may drive the storefront (e.g. `editor::inject`, which
 * evals the script it carries). An exact list of deco admin and Studio
 * origins, never a wildcard: user-written pages live on deco subdomains too
 * (sandbox previews). Also the page itself, and, on a local dev page, other
 * localhost ports (Studio or the admin run locally).
 *
 * A source string, not a function, because every consumer is a bootstrap
 * `<script>` that runs before any bundle loads.
 */
export const EDITOR_ORIGIN_CHECK_JS = `
  var TRUSTED_EDITOR_ORIGINS = [
    "https://deco.cx", "https://admin.deco.cx", "https://v0-admin.deco.cx", "https://play.deco.cx",
    "https://decocms.com", "https://admin.decocms.com", "https://studio.decocms.com", "https://studio-stg.decocms.com"
  ];
  function isLoopbackOrigin(origin) {
    try { return ["localhost", "127.0.0.1", "[::1]"].indexOf(new URL(origin).hostname) !== -1; }
    catch (e) { return false; }
  }
  function isTrustedEditorOrigin(origin) {
    return TRUSTED_EDITOR_ORIGINS.indexOf(origin) !== -1 ||
      origin === window.location.origin ||
      (isLoopbackOrigin(window.location.origin) && isLoopbackOrigin(origin));
  }
`;
