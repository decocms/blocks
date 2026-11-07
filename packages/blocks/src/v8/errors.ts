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

/** Why the content couldn't be read from the delivery CDN (`ContentUnavailableError.reason`). */
export type ContentUnavailableReason = "timeout" | "network" | "http" | "format";

/**
 * The content couldn't be read from the delivery CDN: a fetch ran out of its
 * 10 s (`"timeout"`), failed (`"network"`), was answered with an HTTP error
 * (`"http"`, with `status`; a site that has published nothing yet is a 404),
 * or the body wasn't a release (`"format"`: malformed, or too large). It is
 * the `cause` of the `LOADER_FAILED` error a client reports (`resolve` and
 * `list` answer it, `revision()` rejects with it), so a site can tell it
 * apart and choose what to render: a 503, a fallback, a retry.
 */
export class ContentUnavailableError extends Error {
  readonly reason: ContentUnavailableReason;
  readonly status?: number;

  constructor(
    reason: ContentUnavailableReason,
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ContentUnavailableError";
    this.reason = reason;
    if (options.status !== undefined) this.status = options.status;
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

  /** A saved block whose body couldn't be fetched: its section fails, not the page. */
  blockUnavailable: (name: string, path: (string | number)[], cause: unknown) =>
    new ResolutionError(
      "LOADER_FAILED",
      `the saved block "${name}" couldn't be fetched: ${describe(cause)}`,
      path,
      cause,
    ),

  loaderFailed: (message: string, cause?: unknown) =>
    new ResolutionError(
      "LOADER_FAILED",
      cause === undefined ? message : `${message}: ${describe(cause)}`,
      [],
      cause,
    ),
};
