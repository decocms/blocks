/** Shared by browser serialization and final OTLP encoding; no runtime state. */
const URL_CREDENTIALS = /((?:[a-z][a-z0-9+.-]*:)?\/\/)[^\s/?#"'<>]*@/gi;
// Relative URLs inside exceptions (`/cart?...`, `assets/chunk.js?...`) have
// the same privacy boundary as absolute URLs.
const URL_DETAILS = /([^\s?#"'<>()]+)([?#])([^\s"'<>()]*)/g;
const CREDENTIAL = /\b(Bearer|Basic)\s+[\w~+/.=-]+/gi;
const SENSITIVE =
  /\b(authorization|cookie|set-cookie|x-api-key|api[-_]?key|app[-_]?key|app[-_]?token|token|secret|password)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi;

/** Removes URL details and credential values before exception text leaves its runtime. */
export function scrubText(text: string): string {
  return text
    .replace(URL_CREDENTIALS, "$1")
    .replace(URL_DETAILS, (_url, path: string, separator: string, details: string) => {
      // Browser stack frames append :line:column after a URL's query/hash.
      const position = /(:\d+:\d+)$/.exec(details)?.[1] ?? "";
      return `${path}${separator}[redacted]${position}`;
    })
    .replace(CREDENTIAL, "$1 [redacted]")
    .replace(SENSITIVE, "$1$2[redacted]")
    .slice(0, 1_000);
}
