import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetCookieWarnDedupForTests,
	extractVtexCookies,
	sanitizeOutboundCookieHeader,
	VTEX_COOKIE_PREFIXES,
	warnDroppedCookies,
} from "../cookieSanitizer";

describe("sanitizeOutboundCookieHeader", () => {
	it("returns empty result for empty input", () => {
		expect(sanitizeOutboundCookieHeader("")).toEqual({ cookies: "", dropped: [] });
	});

	it("preserves a clean ASCII cookie header unchanged in content", () => {
		const raw = "checkout.vtex.com=__ofid=abc; vtex_segment=eyJ0b2tlbiI6IjEyMyJ9";
		const { cookies, dropped } = sanitizeOutboundCookieHeader(raw);
		expect(dropped).toEqual([]);
		expect(cookies).toBe("checkout.vtex.com=__ofid=abc; vtex_segment=eyJ0b2tlbiI6IjEyMyJ9");
	});

	it("drops a cookie whose value contains non-ASCII bytes — the casaevideo repro", () => {
		// `Ã¡` is the UTF-8 encoding of `á` interpreted as Latin-1 — bytes 0xC3 0xA1.
		// VTEX's janus gateway returns 503 deterministically when this reaches it.
		const raw = "checkout.vtex.com=__ofid=abc; category_click=EletroportÃ¡teis; vtex_segment=ok";
		const { cookies, dropped } = sanitizeOutboundCookieHeader(raw);
		expect(cookies).toBe("checkout.vtex.com=__ofid=abc; vtex_segment=ok");
		expect(dropped).toEqual([{ name: "category_click", reason: "non_ascii" }]);
	});

	it("drops cookies with raw multi-byte UTF-8 characters", () => {
		const { cookies, dropped } = sanitizeOutboundCookieHeader(
			"checkout.vtex.com=ok; pref=日本語; analytics=tracked",
		);
		expect(cookies).toBe("checkout.vtex.com=ok; analytics=tracked");
		expect(dropped).toEqual([{ name: "pref", reason: "non_ascii" }]);
	});

	it("treats malformed pairs (no `=`, blank name) as dropped", () => {
		const { cookies, dropped } = sanitizeOutboundCookieHeader("justaname; =headless; ok=1; ;");
		expect(cookies).toBe("ok=1");
		expect(dropped.map((d) => d.reason)).toEqual(["malformed", "malformed"]);
	});

	it("preserves URL-encoded values containing `=` signs (JWT-shaped tokens)", () => {
		const raw =
			"VtexIdclientAutCookie=eyJhbGciOiJSUzI1NiIs.eyJzdWIiOiJxIn0.signature; CheckoutOrderFormOwnership=Vk1B%3D%3D";
		const { cookies, dropped } = sanitizeOutboundCookieHeader(raw);
		expect(dropped).toEqual([]);
		expect(cookies).toBe(raw);
	});

	it("rejects cookie names with separators (e.g. spaces) as malformed", () => {
		const { dropped } = sanitizeOutboundCookieHeader("bad name=v; ok=1");
		expect(dropped[0]).toEqual({ name: "bad name", reason: "malformed" });
	});

	it("trims surrounding whitespace between pairs", () => {
		const { cookies } = sanitizeOutboundCookieHeader("  a=1 ;   b=2 ;c=3  ");
		expect(cookies).toBe("a=1; b=2; c=3");
	});

	it("preserves cookie order across the input", () => {
		const { cookies } = sanitizeOutboundCookieHeader("a=1; b=2; c=3; d=4");
		expect(cookies).toBe("a=1; b=2; c=3; d=4");
	});

	it("with allowlist=true keeps only VTEX-prefixed cookies and reports the rest", () => {
		const raw =
			"FPID=abc; checkout.vtex.com=__ofid=xyz; _ga=tracking; vtex_segment=eyJ9; CheckoutOrderFormOwnership=token; __cf_bm=cf";
		const { cookies, dropped } = sanitizeOutboundCookieHeader(raw, { allowlist: true });
		expect(cookies).toBe(
			"checkout.vtex.com=__ofid=xyz; vtex_segment=eyJ9; CheckoutOrderFormOwnership=token",
		);
		expect(dropped.map((d) => d.name).sort()).toEqual(["FPID", "__cf_bm", "_ga"]);
		expect(dropped.every((d) => d.reason === "not_in_allowlist")).toBe(true);
	});

	it("allowlist mode still drops a VTEX-prefixed cookie that has a non-ASCII value", () => {
		const raw = "vtex_segment=okãvalue; checkout.vtex.com=ok";
		const { cookies, dropped } = sanitizeOutboundCookieHeader(raw, { allowlist: true });
		expect(cookies).toBe("checkout.vtex.com=ok");
		expect(dropped).toEqual([{ name: "vtex_segment", reason: "non_ascii" }]);
	});

	it("VTEX_COOKIE_PREFIXES covers the cookies VTEX actions actually depend on", () => {
		// Sanity check — if anyone removes one of these, every action that
		// depends on it will silently 401/redirect on production.
		for (const required of [
			"VtexIdclientAutCookie",
			"checkout.vtex.com",
			"CheckoutOrderFormOwnership",
			"vtex_session",
			"vtex_segment",
		]) {
			expect(VTEX_COOKIE_PREFIXES).toContain(required);
		}
	});
});

describe("extractVtexCookies (allowlist convenience wrapper)", () => {
	it("matches sanitizeOutboundCookieHeader(_, { allowlist: true })", () => {
		const raw =
			"FPID=abc; checkout.vtex.com=__ofid=xyz; category_click=EletroportÃ¡teis; vtex_segment=ok";
		expect(extractVtexCookies(raw)).toBe(
			sanitizeOutboundCookieHeader(raw, { allowlist: true }).cookies,
		);
	});

	it("returns empty string for empty input", () => {
		expect(extractVtexCookies("")).toBe("");
	});
});

describe("warnDroppedCookies", () => {
	beforeEach(() => {
		_resetCookieWarnDedupForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("emits one console.warn per dropped cookie with structured fields", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		warnDroppedCookies(
			[
				{ name: "category_click", reason: "non_ascii" },
				{ name: "_ga", reason: "not_in_allowlist" },
			],
			"acct.vtexcommercestable.com.br",
		);
		expect(warn).toHaveBeenCalledTimes(2);
		expect(warn.mock.calls[0]?.[0]).toMatch(
			/host=acct\.vtexcommercestable\.com\.br name=category_click reason=non_ascii/,
		);
		expect(warn.mock.calls[1]?.[0]).toMatch(/name=_ga reason=not_in_allowlist/);
	});

	it("dedupes repeated drops of the same name+reason+host within the isolate lifetime", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const drop = [{ name: "category_click", reason: "non_ascii" as const }];
		warnDroppedCookies(drop, "acct.vtexcommercestable.com.br");
		warnDroppedCookies(drop, "acct.vtexcommercestable.com.br");
		warnDroppedCookies(drop, "acct.vtexcommercestable.com.br");
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("does not dedupe across different hosts", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const drop = [{ name: "category_click", reason: "non_ascii" as const }];
		warnDroppedCookies(drop, "acct.vtexcommercestable.com.br");
		warnDroppedCookies(drop, "secure.example.com.br");
		expect(warn).toHaveBeenCalledTimes(2);
	});

	it("is a no-op when nothing was dropped", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		warnDroppedCookies([], "any.host");
		expect(warn).not.toHaveBeenCalled();
	});
});
