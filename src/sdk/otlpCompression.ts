/**
 * OTLP/HTTP payload compression.
 *
 * Two algorithms:
 *  - `gzip`: native `CompressionStream("gzip")`. Zero deps, works in every
 *    runtime (workerd, Node ≥18, Deno, Bun).
 *  - `zstd`: `node:zlib` `zstdCompress`. Requires `nodejs_compat` on workerd
 *    (zstd landed in Mar 2026 via cloudflare/workerd#4013) and Node ≥22 on k8s.
 *    ~15-25% smaller than gzip on OTLP JSON batches and cheaper for the
 *    collector to decode. `CompressionStream("zstd")` is still non-standard
 *    (Bun-only, Feb 2026) — revisit when workerd ships it too, then this
 *    file collapses to a single line per format.
 *
 * When `compression: "zstd"` is requested but the runtime doesn't provide
 * `node:zlib.zstdCompress` (no `nodejs_compat`, Node <22, etc.), we silently
 * fall back to gzip. The response header always reflects the actual encoding
 * used, so the collector doesn't need to know which transport was picked.
 */

export type OtlpCompression = "zstd" | "gzip" | "none";

export async function compressJsonPayload(
  payload: unknown,
  compression: OtlpCompression,
): Promise<{ body: BodyInit; contentEncoding?: string }> {
  const json = JSON.stringify(payload);
  if (compression === "none") return { body: json };

  const bytes = new TextEncoder().encode(json);

  if (compression === "zstd") {
    const zstdBytes = await tryZstd(bytes);
    if (zstdBytes) return { body: zstdBytes, contentEncoding: "zstd" };
    // Fall through to gzip when zstd is unavailable in this runtime.
  }

  const stream = new Response(bytes).body!.pipeThrough(
    new CompressionStream("gzip"),
  );
  const gzipBytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return { body: gzipBytes, contentEncoding: "gzip" };
}

// Lazy, cached probe of `node:zlib` zstd. `undefined` = not yet probed,
// `null` = probed and unavailable, function = probed and usable.
let zstdImpl: ((bytes: Uint8Array) => Promise<Uint8Array>) | null | undefined;

async function tryZstd(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (zstdImpl === undefined) {
    zstdImpl = await probeZstd();
  }
  if (!zstdImpl) return null;
  try {
    return await zstdImpl(bytes);
  } catch {
    return null;
  }
}

async function probeZstd(): Promise<((bytes: Uint8Array) => Promise<Uint8Array>) | null> {
  try {
    // Namespace import so bundlers don't try to resolve `node:zlib` at build
    // time in browser/edge builds that never call this path.
    const zlib = await import(/* @vite-ignore */ "node:zlib");
    const zstdCompress = (zlib as unknown as {
      zstdCompress?: (
        buf: Uint8Array,
        cb: (err: Error | null, result: Buffer) => void,
      ) => void;
    }).zstdCompress;
    if (typeof zstdCompress !== "function") return null;
    return (buf) =>
      new Promise((resolve, reject) => {
        zstdCompress(buf, (err, result) => {
          if (err) reject(err);
          else resolve(new Uint8Array(result));
        });
      });
  } catch {
    return null;
  }
}
