/** The request header the site's proxy forwards the visitor's URL on. No imports: safe everywhere. */
export const PAGE_URL_HEADER = "x-deco-page-url";

/** `document.cookie = <Set-Cookie value>`, inert inside a `<script>`. */
export function segmentCookieScript(setCookie: string): string {
  return `document.cookie=${JSON.stringify(setCookie).replace(/</g, "\\u003c")}`;
}
