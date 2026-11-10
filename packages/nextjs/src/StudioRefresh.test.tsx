// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const { StudioRefresh } = await import("./StudioRefresh.tsx");
const { STUDIO_PAGE_REFRESH } = await import("./studio.ts");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Refresh = (url: string) => Promise<void>;
const slot = () => (window as unknown as Record<string, Refresh | undefined>)[STUDIO_PAGE_REFRESH];

let root: Root;
beforeEach(async () => {
  router.refresh.mockReset();
  router.replace.mockReset();
  window.history.replaceState(null, "", "/shoes?__draft=a");
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(<StudioRefresh />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

describe("StudioRefresh", () => {
  it("puts the page's refresh where Studio's HTML swap looks for it", () => {
    expect(typeof slot()).toBe("function");
  });

  it("refreshes the page's own URL in place, and resolves once the transition is over", async () => {
    let done = false;
    // React flushes the transition when act's callback returns, so the
    // promise is awaited after it.
    let refreshed!: Promise<void>;
    await act(async () => {
      refreshed = slot()!(window.location.href).then(() => {
        done = true;
      });
    });
    await refreshed;
    expect(done).toBe(true);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("navigates to a new URL of the page (a moved draft pointer) without scrolling", async () => {
    let refreshed!: Promise<void>;
    await act(async () => {
      refreshed = slot()!(`${window.location.origin}/shoes?__draft=b#top`);
    });
    await refreshed;
    expect(router.replace).toHaveBeenCalledWith("/shoes?__draft=b#top", { scroll: false });
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("refuses another origin's URL", async () => {
    await expect(slot()!("https://elsewhere.example/shoes")).rejects.toThrow(/origin/);
    expect(router.refresh).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("takes it away when it unmounts", async () => {
    await act(async () => root.unmount());
    expect(slot()).toBeUndefined();
    root = createRoot(document.body.appendChild(document.createElement("div")));
  });
});
