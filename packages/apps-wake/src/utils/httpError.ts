/**
 * Minimal HTTP error carrying a status code.
 *
 * The Deno Wake app threw `HttpError` from `deco/utils/http.ts`; in this
 * architecture actions just throw `Error`, so this local class preserves the
 * `.status` field that some callers/handlers inspect.
 */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message?: string) {
    super(message ?? `HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
  }
}
