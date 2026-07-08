/**
 * Tests for utils/parseUserCookie.ts.
 *
 * Locks the contract that downstream loaders depend on:
 *  - puid wins over uuid (signed-in identity > anonymous device id)
 *  - uuid is used when puid is missing
 *  - empty / missing / malformed cookies fall back to "anonymous"
 *
 * The fallback is load-bearing — Evergage rejects requests with a
 * missing user identifier, so an unparseable cookie must not surface
 * as `{}`.
 */
import { describe, expect, it } from "vitest";
import { parseUserCookie } from "../utils/parseUserCookie";

const encode = (obj: unknown) => encodeURIComponent(JSON.stringify(obj));

describe("parseUserCookie", () => {
	it("returns anonymous fallback when cookie is undefined", () => {
		expect(parseUserCookie(undefined)).toEqual({ anonymousId: "anonymous" });
	});

	it("returns anonymous fallback when cookie is null", () => {
		expect(parseUserCookie(null)).toEqual({ anonymousId: "anonymous" });
	});

	it("returns anonymous fallback when cookie is empty string", () => {
		expect(parseUserCookie("")).toEqual({ anonymousId: "anonymous" });
	});

	it("returns anonymous fallback when cookie is whitespace only", () => {
		expect(parseUserCookie("   ")).toEqual({ anonymousId: "anonymous" });
	});

	it("returns anonymous fallback when cookie is not valid JSON", () => {
		expect(parseUserCookie("not-json")).toEqual({ anonymousId: "anonymous" });
	});

	it("returns anonymous fallback when JSON value is not an object", () => {
		expect(parseUserCookie(encode("string-value"))).toEqual({ anonymousId: "anonymous" });
		expect(parseUserCookie(encode(42))).toEqual({ anonymousId: "anonymous" });
		expect(parseUserCookie(encode(null))).toEqual({ anonymousId: "anonymous" });
	});

	it("maps puid to encryptedId", () => {
		expect(parseUserCookie(encode({ puid: "user-123" }))).toEqual({
			encryptedId: "user-123",
		});
	});

	it("maps uuid to anonymousId", () => {
		expect(parseUserCookie(encode({ uuid: "device-abc" }))).toEqual({
			anonymousId: "device-abc",
		});
	});

	it("prefers puid over uuid when both are present", () => {
		expect(parseUserCookie(encode({ puid: "user-123", uuid: "device-abc" }))).toEqual({
			encryptedId: "user-123",
		});
	});

	it("returns anonymous fallback when puid is empty string", () => {
		expect(parseUserCookie(encode({ puid: "", uuid: "device-abc" }))).toEqual({
			anonymousId: "device-abc",
		});
	});

	it("returns anonymous fallback when both puid and uuid are empty/missing", () => {
		expect(parseUserCookie(encode({}))).toEqual({ anonymousId: "anonymous" });
		expect(parseUserCookie(encode({ puid: "", uuid: "" }))).toEqual({
			anonymousId: "anonymous",
		});
	});

	it("returns anonymous fallback when puid/uuid are non-string types", () => {
		expect(parseUserCookie(encode({ puid: 42, uuid: true }))).toEqual({
			anonymousId: "anonymous",
		});
	});

	it("decodes URL-encoded values", () => {
		// Evergage encodes the JSON with encodeURIComponent — make sure
		// embedded special chars (e.g. = / : in base64 ids) round-trip.
		const puid = "abc=def+ghi/jkl";
		const cookie = encodeURIComponent(JSON.stringify({ puid }));
		expect(parseUserCookie(cookie)).toEqual({ encryptedId: puid });
	});
});
