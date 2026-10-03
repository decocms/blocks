/**
 * Content hashes for the filesystem storage. A file's version is its git blob
 * hash (`sha1("blob <size>\0" + bytes)`), the same identifier GitHub uses, so
 * versions read from a working tree match `git hash-object`.
 */
import { createHash } from "node:crypto";

/** The git blob hash of `content`, as git computes it for `git hash-object`. */
export function gitBlobHash(content: Uint8Array | string): string {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

/** A revision of a set of files: SHA-256 over the sorted `file\0version` listing. */
export function revisionOf(files: Iterable<{ file: string; version: string }>): string {
  const listing = [...files]
    .map(({ file, version }) => `${file}\0${version}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(listing).digest("hex");
}
