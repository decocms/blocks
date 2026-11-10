// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);
const router = vi.hoisted(() => ({
  navigate: vi.fn(async (opts: { href: string }) => {
    calls.push(`navigate ${opts.href}`);
  }),
  invalidate: vi.fn(async () => {
    calls.push("invalidate");
  }),
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => router }));

const { StudioRefresh } = await import("./StudioRefresh.ts");
const { STUDIO_PAGE_REFRESH } = await import("../studio.ts");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Refresh = (url: string) => Promise<void>;
const slot = () => (window as unknown as Record<string, Refresh | undefined>)[STUDIO_PAGE_REFRESH];
const realFetch = globalThis.fetch;

let root: Root;
beforeEach(async () => {
  calls.length = 0;
  router.navigate.mockClear();
  router.invalidate.mockClear();
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(`fetch ${String(input)}`);
    return new Response("<html></html>");
  }) as typeof fetch;
  window.history.replaceState(null, "", "/shoes?__draft=a");
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(<StudioRefresh />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  globalThis.fetch = realFetch;
  document.body.innerHTML = "";
});

describe("StudioRefresh", () => {
  it("reruns the loaders for the page's own URL, fetching nothing else", async () => {
    await slot()!(window.location.href);
    expect(calls).toEqual(["invalidate"]);
  });

  it("a moved draft pointer: the link's cookie first, then the URL, then the loaders", async () => {
    const next = `${window.location.origin}/shoes?__draft=b`;
    await slot()!(next);
    expect(calls).toEqual([`fetch ${next}`, "navigate /shoes?__draft=b", "invalidate"]);
    expect(router.navigate).toHaveBeenCalledWith({
      href: "/shoes?__draft=b",
      replace: true,
      resetScroll: false,
    });
  });

  it("rejects when the new link fails, leaving the page as it is", async () => {
    globalThis.fetch = vi.fn(async () => new Response("", { status: 500 })) as typeof fetch;
    await expect(slot()!(`${window.location.origin}/shoes?__draft=b`)).rejects.toThrow(/500/);
    expect(router.navigate).not.toHaveBeenCalled();
    expect(router.invalidate).not.toHaveBeenCalled();
  });

  it("refuses another origin's URL", async () => {
    await expect(slot()!("https://elsewhere.example/shoes")).rejects.toThrow(/origin/);
    expect(calls).toEqual([]);
  });

  it("takes it away when it unmounts", async () => {
    await act(async () => root.unmount());
    expect(slot()).toBeUndefined();
    root = createRoot(document.body.appendChild(document.createElement("div")));
  });
});
