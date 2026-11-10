/**
 * The page's own refresh for Studio's HTML swap (`STUDIO_PAGE_REFRESH` of
 * `@decocms/blocks/protocol`): after a save, Studio asks the page to show its
 * new content. Replacing the document would leave React holding the old nodes,
 * so every client component would stop at its server markup. Here the router
 * does it instead and stays attached: `router.invalidate()` reruns the loaders
 * and resolves once the page shows their data.
 *
 * A new URL of the page (a save moved the draft pointer in `?__draft=`) first
 * goes to the worker as a document request, only for its draft cookie: the
 * loaders' server-function calls carry the cookie, not the page's query. Then
 * the router moves to the URL and reruns the loaders.
 *
 * Set on every page, framed or not: Studio's module is the only caller, and
 * comparing the window with its parent here is what a test runner's
 * frame-busting rewrite matches (`tests/studio-shortcut.test.ts`).
 */
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { STUDIO_PAGE_REFRESH } from "../studio.ts";

type StudioPageRefresh = (url: string) => Promise<void>;

export function StudioRefresh(): null {
  const router = useRouter();

  useEffect(() => {
    const refresh: StudioPageRefresh = async (url) => {
      const target = new URL(url, location.href);
      if (target.origin !== location.origin) {
        throw new Error(`Not this page's origin: ${target.origin}`);
      }
      if (target.href !== location.href) {
        const res = await fetch(target.href, {
          headers: { accept: "text/html" },
          credentials: "same-origin",
          cache: "no-store",
        });
        await res.body?.cancel();
        if (!res.ok) throw new Error(`The page answered ${res.status}`);
        await router.navigate({
          href: `${target.pathname}${target.search}${target.hash}`,
          replace: true,
          resetScroll: false,
        });
      }
      await router.invalidate();
    };
    const slot = window as unknown as Record<string, unknown>;
    slot[STUDIO_PAGE_REFRESH] = refresh;
    return () => {
      if (slot[STUDIO_PAGE_REFRESH] === refresh) delete slot[STUDIO_PAGE_REFRESH];
    };
  }, [router]);

  return null;
}
