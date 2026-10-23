/**
 * Web-platform base64 / base64url helpers.
 *
 * Replaces the surface area of Deno's `@std/encoding/base64` so deco
 * storefronts on TanStack/Workers can drop the per-site shim.
 *
 * All implementations use the global `btoa` / `atob` (available in Workers,
 * browsers, and Node 16+) so there is zero runtime dependency.
 */

function toBytes(data: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}

type NativeBase64 = { toBase64?: () => string };
type NativeFromBase64 = { fromBase64?: (b64: string) => Uint8Array<ArrayBuffer> };

export function encodeBase64(data: ArrayBuffer | Uint8Array | string): string {
  const bytes = toBytes(data);
  // workerd encodes natively, straight from the bytes, with the same output as btoa().
  const native = (bytes as NativeBase64).toBase64;
  if (native) return native.call(bytes);
  // Chunked so a large input doesn't blow the call stack. `apply`, not a spread: spreading
  // a Uint8Array goes through its iterator, one `{ value, done }` object per byte, ~24 MB
  // of garbage for a 1 MB HTML body.
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

export function decodeBase64(b64: string): Uint8Array<ArrayBuffer> {
  const native = (Uint8Array as unknown as NativeFromBase64).fromBase64;
  if (native) return native(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeBase64Url(data: ArrayBuffer | Uint8Array | string): string {
  return encodeBase64(data).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeBase64Url(b64url: string): Uint8Array {
  const padded = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  return decodeBase64(padded + "=".repeat(padLen));
}
