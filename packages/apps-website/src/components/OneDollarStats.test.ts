// Runs under the workspace default jsdom environment (see root vitest.config.ts) —
// apps-start used happy-dom for this file specifically, but this repo standardizes
// on jsdom for all packages/*/src, and the DOM APIs this test exercises (document,
// window, history, cookies) are supported by both.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetForTests,
	initOneDollarStats,
	readFlagsFromCookie,
	truncate,
} from "./OneDollarStats";

const ORIGINAL_PUSH_STATE = history.pushState.bind(history);

function clearAllCookies() {
	const names = document.cookie
		.split(";")
		.map((c) => c.split("=")[0]?.trim())
		.filter(Boolean);
	for (const n of names) {
		document.cookie = `${n}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
		document.cookie = `${n}=; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
	}
}

beforeEach(() => {
	// Use fake timers so leftover poll intervals from a prior init can't fire
	// into the next test's window — and so we can advance time deterministically.
	vi.useFakeTimers();
	__resetForTests();
	clearAllCookies();
	history.pushState = ORIGINAL_PUSH_STATE;
	(globalThis as { stonks?: unknown }).stonks = undefined;
	(globalThis as { DECO?: unknown }).DECO = undefined;
});

afterEach(() => {
	// Drain any leftover timers before tearing down so they don't bleed across tests.
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe("truncate", () => {
	it("returns the string unchanged when under the limit", () => {
		expect(truncate("hello")).toBe("hello");
	});

	it("caps long strings at 990 chars", () => {
		const big = "a".repeat(2000);
		expect(truncate(big)).toHaveLength(990);
	});

	it("stringifies numbers and booleans", () => {
		expect(truncate(42)).toBe("42");
		expect(truncate(true)).toBe("true");
	});

	it("JSON-stringifies objects and arrays", () => {
		expect(truncate({ a: 1 })).toBe('{"a":1}');
		expect(truncate([1, 2])).toBe("[1,2]");
	});
});

describe("readFlagsFromCookie", () => {
	function encodeSegment(payload: object): string {
		return btoa(encodeURIComponent(JSON.stringify(payload)));
	}

	it("returns an empty object when no deco_segment cookie is present", () => {
		expect(readFlagsFromCookie("")).toEqual({});
		expect(readFlagsFromCookie("foo=bar; baz=qux")).toEqual({});
	});

	it("decodes active flags as true and inactiveDrawn as false", () => {
		const cookie = `deco_segment=${encodeSegment({
			active: ["new_home", "promo_v2"],
			inactiveDrawn: ["old_promo"],
		})}`;
		expect(readFlagsFromCookie(cookie)).toEqual({
			new_home: true,
			promo_v2: true,
			old_promo: false,
		});
	});

	it("ignores other cookies", () => {
		const cookie = `csrf=abc; deco_segment=${encodeSegment({ active: ["x"] })}; theme=dark`;
		expect(readFlagsFromCookie(cookie)).toEqual({ x: true });
	});

	it("returns an empty object on malformed cookie", () => {
		expect(readFlagsFromCookie("deco_segment=not-base64!")).toEqual({});
		expect(readFlagsFromCookie("deco_segment=YWJj")).toEqual({}); // valid b64, invalid json
	});

	it("handles empty active/inactiveDrawn arrays", () => {
		const cookie = `deco_segment=${encodeSegment({ active: [], inactiveDrawn: [] })}`;
		expect(readFlagsFromCookie(cookie)).toEqual({});
	});
});

describe("initOneDollarStats", () => {
	function setStonks(view = vi.fn(), event = vi.fn()) {
		(window as Window & { stonks?: unknown }).stonks = { view, event };
		return { view, event };
	}

	function setDeco() {
		const subscribers: Array<(e: unknown) => void> = [];
		(window as Window & { DECO?: unknown }).DECO = {
			events: {
				subscribe: (fn: (e: unknown) => void) => {
					subscribers.push(fn);
				},
			},
		};
		return subscribers;
	}

	it("fires the initial pageview with cookie flags once stonks is ready", () => {
		const { view } = setStonks();
		document.cookie = `deco_segment=${btoa(encodeURIComponent(JSON.stringify({ active: ["abtest_a"] })))}`;

		initOneDollarStats();
		// stonks was ready immediately → first call fires synchronously, no polling.
		expect(view).toHaveBeenCalledTimes(1);
		expect(view).toHaveBeenCalledWith({ abtest_a: true });
	});

	it("waits for stonks via polling when SDK loads late", () => {
		const view = vi.fn();
		// Stonks NOT set yet.
		initOneDollarStats();
		expect(view).not.toHaveBeenCalled();

		// SDK arrives a few ticks later.
		(window as Window & { stonks?: unknown }).stonks = { view };
		vi.advanceTimersByTime(100);

		expect(view).toHaveBeenCalledTimes(1);
		expect(view).toHaveBeenCalledWith({});
	});

	it("fires a pageview on history.pushState (SPA nav)", () => {
		const { view } = setStonks();
		initOneDollarStats();
		view.mockClear();

		history.pushState({}, "", "/somewhere");
		expect(view).toHaveBeenCalledTimes(1);
	});

	it("fires a pageview on popstate", () => {
		const { view } = setStonks();
		initOneDollarStats();
		view.mockClear();

		dispatchEvent(new Event("popstate"));
		expect(view).toHaveBeenCalledTimes(1);
	});

	it("is idempotent — second call does nothing, wrapper installed once", () => {
		const { view } = setStonks();
		initOneDollarStats();
		initOneDollarStats();
		initOneDollarStats();

		expect(view).toHaveBeenCalledTimes(1);

		view.mockClear();
		history.pushState({}, "", "/x");
		expect(view).toHaveBeenCalledTimes(1);
	});

	it("forwards DECO events to stonks.event with flag enrichment, skipping 'deco' events", () => {
		const { event } = setStonks();
		const subscribers = setDeco();
		document.cookie = `deco_segment=${btoa(encodeURIComponent(JSON.stringify({ active: ["v2"] })))}`;

		initOneDollarStats();

		expect(subscribers).toHaveLength(1);
		const dispatch = subscribers[0]!;

		dispatch({ name: "deco", params: { foo: 1 } });
		expect(event).not.toHaveBeenCalled();

		dispatch({ name: "add_to_cart", params: { sku: "ABC", price: 99 } });
		expect(event).toHaveBeenCalledTimes(1);
		expect(event).toHaveBeenCalledWith("add_to_cart", {
			v2: true,
			sku: "ABC",
			price: "99",
		});
	});

	it("ignores subscribed events that lack a name", () => {
		const { event } = setStonks();
		const subscribers = setDeco();

		initOneDollarStats();

		subscribers[0]!(null);
		subscribers[0]!(undefined);
		subscribers[0]!({});
		expect(event).not.toHaveBeenCalled();
	});

	it("drops null/undefined params, retains other values, and ignores deco_segment when not set", () => {
		const { event } = setStonks();
		const subscribers = setDeco();

		initOneDollarStats();

		subscribers[0]!({ name: "ev", params: { keep: "x", drop: null, also_drop: undefined } });
		expect(event).toHaveBeenCalledWith("ev", { keep: "x" });
	});
});
