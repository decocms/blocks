/**
 * Asset-upload naming rules shared by the asset handler and the storages.
 * Browser-safe.
 */

/** Content types the asset endpoint accepts. */
export function isAcceptedAssetType(contentType: string | null): boolean {
  if (!contentType) return false;
  const type = contentType.split(";")[0].trim().toLowerCase();
  return (
    /^image\/[a-z0-9.+-]+$/.test(type) ||
    /^video\/[a-z0-9.+-]+$/.test(type) ||
    /^font\/[a-z0-9.+-]+$/.test(type) ||
    type === "application/pdf" ||
    type === "application/font-woff" ||
    type === "application/x-font-ttf" ||
    type === "application/vnd.ms-fontobject"
  );
}

/**
 * Normalizes an upload's file name: its last path segment, lowercased
 * extension, with anything but letters, digits, `.`, `_` and `-` replaced.
 * Returns `null` when nothing usable is left.
 */
export function sanitizeAssetName(raw: string): string | null {
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    name = raw;
  }
  name = name.split(/[\\/]/).pop() ?? "";
  name = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/-+(\.|$)/g, "$1");
  if (!name || name === "." || name === "..") return null;
  if (name.length > 200) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot).slice(0, 16) : "";
    name = name.slice(0, 200 - ext.length) + ext;
  }
  return name;
}

/**
 * The name to try when `name` is taken: a short random suffix before the
 * extension, such as `banner-3f9a2c.jpg`.
 */
export function suffixedAssetName(name: string): string {
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}-${suffix}${name.slice(dot)}` : `${name}-${suffix}`;
}
