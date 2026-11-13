// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startAnalytics = vi.hoisted(() => vi.fn(async () => null));
vi.mock("@decocms/blocks/analytics/client", () => ({ startAnalytics }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const w = window as unknown as Record<string, unknown>;

/** A fresh page: no client started yet. */
beforeEach(() => {
  vi.resetModules();
  startAnalytics.mockClear();
});
afterEach(() => {
  delete w.__DECO_EXPERIMENTS;
});

async function mount(element: (C: typeof import("./DecoAnalytics.ts").DecoAnalytics) => unknown) {
  const { DecoAnalytics } = await import("./DecoAnalytics.ts");
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(element(DecoAnalytics) as never));
  return { root, DecoAnalytics };
}

describe("DecoAnalytics", () => {
  it("starts the client once, with the site's options and the tests the page published", async () => {
    w.__DECO_EXPERIMENTS = { "hero-copy": true, "buy-button": false };
    const { root, DecoAnalytics } = await mount((C) => <C modules={["click"]} />);
    // A re-render, or a second copy on the page, starts nothing more.
    await act(async () => root.render(<DecoAnalytics modules={["click"]} sampling={0.5} />));
    expect(startAnalytics.mock.calls).toEqual([
      [{ modules: ["click"], experiments: { "hero-copy": true, "buy-button": false } }],
    ]);
  });

  it("starts it without tests when the page published none (a preview, or no experiments block)", async () => {
    await mount((C) => <C endpoint="https://collector.example/_dq/e" />);
    expect(startAnalytics.mock.calls).toEqual([[{ endpoint: "https://collector.example/_dq/e" }]]);
  });
});
