/**
 * Decode the JSON-encoded user identifier cookie set by Salesforce
 * Marketing Cloud Personalization (Evergage) on the browser.
 *
 * Evergage stores `{ puid?: string, uuid?: string }` URL-encoded:
 *  - `puid` (persistent user id) is present after the user signs in
 *  - `uuid` (anonymous device id) is dropped on first visit
 *
 * The personalization API expects EITHER `encryptedId` (mapped from
 * `puid`) OR `anonymousId` (mapped from `uuid`). When the cookie is
 * missing or malformed, we fall back to the literal "anonymous" so
 * the API still returns a default campaign instead of erroring.
 */
import type { ParsedUserCookie } from "../types";

const ANONYMOUS_FALLBACK: ParsedUserCookie = { anonymousId: "anonymous" };

export function parseUserCookie(rawCookie: string | undefined | null): ParsedUserCookie {
	if (!rawCookie?.trim()) return ANONYMOUS_FALLBACK;

	try {
		const decoded = decodeURIComponent(rawCookie);
		const parsed: unknown = JSON.parse(decoded);
		if (typeof parsed !== "object" || parsed === null) return ANONYMOUS_FALLBACK;

		const { puid, uuid } = parsed as { puid?: unknown; uuid?: unknown };

		// puid wins over uuid when both are present — once a user signs in,
		// every request should be attributed to their persistent identity
		// so cross-device personalization works.
		if (typeof puid === "string" && puid.length > 0) {
			return { encryptedId: puid };
		}
		if (typeof uuid === "string" && uuid.length > 0) {
			return { anonymousId: uuid };
		}
		return ANONYMOUS_FALLBACK;
	} catch {
		return ANONYMOUS_FALLBACK;
	}
}
