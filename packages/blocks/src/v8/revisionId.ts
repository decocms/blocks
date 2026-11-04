/**
 * A published revision's id: `<inv>-<uuidv7>`, a UUIDv7 (RFC 9562, lowercase)
 * after 12 hex digits of `2^48 - 1 -` its millisecond timestamp, so ids sort
 * newest first. Only Studio mints them; the SDK and the CLI only check the
 * shape (the prefix isn't recomputed). `latest.json` names one, and it is
 * the folder of `sites/<site>/revisions/<id>/data.json`.
 */
export const REVISION_ID_RE =
  /^[0-9a-f]{12}-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Whether `value` has the shape of a revision id. */
export function isRevisionId(value: unknown): value is string {
  return typeof value === "string" && REVISION_ID_RE.test(value);
}
