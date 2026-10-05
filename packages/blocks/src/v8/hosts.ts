/**
 * Host patterns (see /next/api-reference#host-patterns): the format of
 * `preview.hosts`, in `createCMS` and in the `CMS` block.
 *
 * - Hostnames and patterns are compared lowercase, with one trailing dot
 *   removed; names outside ASCII in their punycode form.
 * - A pattern without `*` matches that one hostname.
 * - `*.name` matches a hostname that ends in `.name` with at least one more
 *   label in front, compared label by label from the right. `*` is only ever
 *   the whole leading label, and at least two labels follow it.
 * - `"*"` alone matches every host.
 * - A pattern without a port matches any port; one with a port matches only
 *   a URL that names that port.
 * - IPv4, and IPv6 in brackets, match exactly and never take a wildcard.
 * - Anything else (a scheme, a path, a space, an empty label) isn't a pattern.
 */

/** A parsed pattern. `port` is absent when the pattern names none. */
export type HostPattern =
  | { kind: "any" }
  | { kind: "name"; host: string; port?: string }
  | { kind: "wildcard"; suffix: string; port?: string }
  | { kind: "ip"; host: string; port?: string };

/** The list that allows every host. */
export const EVERY_HOST = "*";

const LABEL_RE = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/;
const PORT_RE = /^[0-9]{1,5}$/;
const IPV4_RE =
  /^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$/;
const NUMERIC_LABEL_RE = /^(0x[0-9a-f]*|[0-9]+)$/;

/** Parses one pattern; `null` when it isn't one. */
export function parseHostPattern(raw: unknown): HostPattern | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 300) return null;
  if (raw === EVERY_HOST) return { kind: "any" };
  if (/[\s/\\?#@]/.test(raw) || raw.includes("://")) return null;
  const split = splitPort(raw);
  if (split === null) return null;
  const { port } = split;
  let host = split.host;
  if (host.startsWith("[")) {
    const ip = normalizeIPv6(host);
    return ip === null ? null : withPort({ kind: "ip", host: ip }, port);
  }
  host = host.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.startsWith("*.")) {
    const suffix = normalizeName(host.slice(2));
    if (suffix === null || suffix.split(".").length < 2) return null;
    return withPort({ kind: "wildcard", suffix }, port);
  }
  if (IPV4_RE.test(host)) return withPort({ kind: "ip", host }, port);
  const name = normalizeName(host);
  return name === null ? null : withPort({ kind: "name", host: name }, port);
}

/** Formats a parsed pattern back into its normal form. */
export function formatHostPattern(pattern: HostPattern): string {
  if (pattern.kind === "any") return EVERY_HOST;
  const host = pattern.kind === "wildcard" ? `*.${pattern.suffix}` : pattern.host;
  return pattern.port === undefined ? host : `${host}:${pattern.port}`;
}

/**
 * Whether a request URL's host is one a pattern matches. A URL that can't be
 * read matches only `"*"`.
 */
export function hostMatches(pattern: HostPattern, url: URL | null): boolean {
  if (pattern.kind === "any") return true;
  if (url === null) return false;
  if (pattern.port !== undefined && pattern.port !== url.port) return false;
  let host = url.hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  switch (pattern.kind) {
    case "name":
    case "ip":
      return host === pattern.host;
    case "wildcard":
      return host.length > pattern.suffix.length + 1 && host.endsWith(`.${pattern.suffix}`);
  }
}

/** Whether a request may preview under this list: some pattern matches its URL's host. */
export function allowsHost(patterns: readonly HostPattern[], requestUrl: string): boolean {
  let url: URL | null;
  try {
    url = new URL(requestUrl);
  } catch {
    url = null;
  }
  return patterns.some((pattern) => hostMatches(pattern, url));
}

/**
 * Whether every host `inner` matches is matched by `outer`: content's entry
 * `inner` is within code's entry `outer`.
 */
export function patternWithin(inner: HostPattern, outer: HostPattern): boolean {
  if (outer.kind === "any") return true;
  if (inner.kind === "any") return false;
  if (outer.port !== undefined && inner.port !== outer.port) return false;
  switch (outer.kind) {
    case "name":
    case "ip":
      return inner.kind === outer.kind && inner.host === outer.host;
    case "wildcard":
      if (inner.kind === "name") return inner.host.endsWith(`.${outer.suffix}`);
      if (inner.kind === "wildcard") {
        return inner.suffix === outer.suffix || inner.suffix.endsWith(`.${outer.suffix}`);
      }
      return false;
  }
}

function withPort<T extends HostPattern>(pattern: T, port: string | undefined): T {
  return port === undefined ? pattern : { ...pattern, port };
}

/** `host[:port]`, with the port checked; `null` on an empty host or a bad port. */
function splitPort(raw: string): { host: string; port?: string } | null {
  let host = raw;
  let port: string | undefined;
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end === -1) return null;
    host = raw.slice(0, end + 1);
    const rest = raw.slice(end + 1);
    if (rest !== "") {
      if (!rest.startsWith(":")) return null;
      port = rest.slice(1);
    }
  } else {
    const colon = raw.indexOf(":");
    if (colon !== -1) {
      if (raw.indexOf(":", colon + 1) !== -1) return null; // an IPv6 address without brackets
      host = raw.slice(0, colon);
      port = raw.slice(colon + 1);
    }
  }
  if (host === "") return null;
  if (port !== undefined && (!PORT_RE.test(port) || Number(port) > 65535)) return null;
  // The form a URL gives it: no leading zeros.
  return port === undefined ? { host } : { host, port: String(Number(port)) };
}

/** A DNS name in its ASCII (punycode) form, lowercase; `null` if it isn't one. */
function normalizeName(name: string): string | null {
  if (name === "" || name.includes("*")) return null;
  let ascii = name;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the ASCII range is the point
  if (/[^\x00-\x7f]/.test(name)) {
    try {
      ascii = new URL(`http://${name}/`).hostname;
    } catch {
      return null;
    }
  }
  const labels = ascii.split(".");
  if (labels.some((label) => !LABEL_RE.test(label))) return null;
  // A name ending in a numeric label is an IPv4 address to a URL parser: only
  // the canonical dotted form above is one.
  if (NUMERIC_LABEL_RE.test(labels[labels.length - 1])) return null;
  return ascii.length > 253 ? null : ascii;
}

/** `[addr]` in the compressed, lowercase form a URL's hostname has. */
function normalizeIPv6(bracketed: string): string | null {
  if (!/^\[[0-9a-fA-F:.]+\]$/.test(bracketed)) return null;
  try {
    const host = new URL(`http://${bracketed}/`).hostname;
    return host.startsWith("[") ? host : null;
  } catch {
    return null;
  }
}
