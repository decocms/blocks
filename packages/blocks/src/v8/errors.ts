import type { CMSError, CMSErrorCode } from "./types.ts";

/**
 * The concrete {@link CMSError}. It extends `Error` so a lazy block can reject
 * with it (and a stack trace survives), while still satisfying the plain
 * `{ code, message, path, cause }` shape the API documents.
 */
export class ResolutionError extends Error implements CMSError {
  readonly code: CMSErrorCode;
  readonly path: (string | number)[];
  override readonly cause?: unknown;

  constructor(code: CMSErrorCode, message: string, path: (string | number)[], cause?: unknown) {
    super(message);
    this.name = "CMSError";
    this.code = code;
    this.path = path;
    if (cause !== undefined) this.cause = cause;
  }
}

export function isResolutionError(value: unknown): value is ResolutionError {
  return value instanceof ResolutionError;
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  try {
    return String(cause);
  } catch {
    return "unknown error";
  }
}

export const errors = {
  notFound: (name: string) =>
    new ResolutionError("NOT_FOUND", `no saved block named "${name}"`, []),

  unknownBlock: (type: string, path: (string | number)[]) =>
    new ResolutionError(
      "UNKNOWN_BLOCK",
      `"${type}" is neither a type in the block map nor a saved block`,
      path,
    ),

  cycle: (chain: string[]) =>
    new ResolutionError("CYCLE", `saved blocks refer to each other: ${chain.join(" → ")}`, chain),

  blockFailed: (type: string, path: (string | number)[], cause: unknown) =>
    new ResolutionError("BLOCK_FAILED", `block "${type}" failed: ${describe(cause)}`, path, cause),

  loaderFailed: (message: string, cause?: unknown) =>
    new ResolutionError(
      "LOADER_FAILED",
      cause === undefined ? message : `${message}: ${describe(cause)}`,
      [],
      cause,
    ),
};
