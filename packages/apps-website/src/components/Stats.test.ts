// The gate and the tag. There is no client behaviour to test — the collector's bundle owns
// pageviews, SPA navigation and DECO events, and it is tested where it lives. What can break
// here is what this component actually decides: whether to render at all, where it points, and
// which attributes it emits.
//
// `renderToStaticMarkup` rather than a DOM render: the component has no effects and no state, so
// mounting it would test React rather than this file.
import { afterEach, describe, expect, it, vi } from "vitest";

const ENV = { ...process.env };

afterEach(() => {
	process.env = { ...ENV };
	vi.resetModules();
});

/** Re-imported per test, because the gate is read at MODULE LOAD. A test that sets the variable
 *  after importing would be asserting against the value the previous test left behind — and it
 *  would pass or fail depending on file order, which is the worst kind of green. */
async function render(props: Record<string, unknown> = {}) {
	const { renderToStaticMarkup } = await import("react-dom/server");
	const { default: Stats } = await import("./Stats");
	const { createElement } = await import("react");
	return renderToStaticMarkup(createElement(Stats, props));
}

describe("Stats", () => {
	it("renders nothing unless explicitly enabled", async () => {
		delete process.env.DECO_ANALYTICS_ENABLED;
		expect(await render()).toBe("");

		// Not "any truthy value". `ONEDOLLAR_ENABLED` defaults to ON and is disabled with
		// "false"; this one defaults to OFF and needs "true". A loose check here would make
		// `DECO_ANALYTICS_ENABLED=0` turn analytics on, which is the opposite of what anyone
		// setting it to 0 intends.
		process.env.DECO_ANALYTICS_ENABLED = "1";
		vi.resetModules();
		expect(await render()).toBe("");
	});

	it("points at the same origin by default, and preconnects only when it does not", async () => {
		process.env.DECO_ANALYTICS_ENABLED = "true";
		const same = await render();
		expect(same).toContain('src="/_dq/a.js"');
		// A preconnect to the page's own origin is a wasted hint, and on some browsers a
		// second connection opened for nothing.
		expect(same).not.toContain("preconnect");

		vi.resetModules();
		process.env.DECO_ANALYTICS_ORIGIN = "https://analytics.example.com";
		const cross = await render();
		expect(cross).toContain('src="https://analytics.example.com/_dq/a.js"');
		expect(cross).toContain("preconnect");
	});

	it("carries dev and debug as attributes, and omits them when off", async () => {
		process.env.DECO_ANALYTICS_ENABLED = "true";
		// The whole reason these are attributes: TanStack hoists `<script async>` into `<head>`
		// above any inline config block, so a global set alongside the tag loses the race and the
		// collector boots into silence with no error.
		const on = await render({ dev: true, debug: true });
		expect(on).toContain('data-dev="true"');
		expect(on).toContain('data-debug="true"');

		vi.resetModules();
		const off = await render();
		// Absent, not `="false"`. The collector treats them the same; a reader of the page source
		// does not, and `data-dev="false"` looks like someone decided something.
		expect(off).not.toContain("data-dev");
		expect(off).not.toContain("data-debug");
	});

	it("emits a site key only when one is configured", async () => {
		process.env.DECO_ANALYTICS_ENABLED = "true";
		// Sites behind our edge are identified by the Host header, which a visitor cannot forge.
		// Emitting an empty key would put a `tag`-sourced identity on a site that has a
		// trustworthy one, and `tag` is the source that must never reach an invoice.
		expect(await render()).not.toContain("data-site");

		vi.resetModules();
		process.env.DECO_ANALYTICS_SITE_KEY = "dq_abc123";
		expect(await render()).toContain('data-site="dq_abc123"');
	});

	it("uses defer only when asked, async otherwise", async () => {
		process.env.DECO_ANALYTICS_ENABLED = "true";
		// Nothing visual may depend on this script. `async` is what keeps a slow or failed
		// collector from becoming a slow or broken page.
		expect(await render()).toContain("async");

		vi.resetModules();
		const deferred = await render({ defer: true });
		expect(deferred).toContain("defer");
		expect(deferred).not.toContain("async");
	});
});
