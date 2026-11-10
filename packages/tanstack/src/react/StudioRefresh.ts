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
 * the router moves to the URL. A route whose loader deps include `__draft`
 * loads again on that move; only the matches it didn't load are invalidated,
 * so the page renders the save once.
 *
 * The page keeps its scroll position. After every load the router restores
 * the position saved for the URL or scrolls to the top, and `invalidate()`
 * takes no `resetScroll`, so an editor working on the footer was sent back
 * up on every save. While a refresh runs, `scrollRestoration` is a function
 * that answers `false`, which the router reads as "leave the scroll alone";
 * the site's own setting is back two frames after the last render.
 *
 * Set on every page, framed or not: Studio's module is the only caller, and
 * comparing the window with its parent here is what a test runner's
 * frame-busting rewrite matches (`tests/studio-shortcut.test.ts`).
 */
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { STUDIO_PAGE_REFRESH } from "../studio.ts";

type StudioPageRefresh = (url: string) => Promise<void>;
type Router = ReturnType<typeof useRouter>;

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Runs `work` with the router's scroll restoration off; overlapping calls share one override. */
function keepScroll(router: Router) {
  let depth = 0;
  let saved: Router["options"]["scrollRestoration"];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (depth++ === 0) {
      saved = router.options.scrollRestoration;
      router.options.scrollRestoration = () => false;
    }
    try {
      return await work();
    } finally {
      await nextFrame();
      await nextFrame();
      if (--depth === 0) router.options.scrollRestoration = saved;
    }
  };
}

export function StudioRefresh(): null {
  const router = useRouter();

  useEffect(() => {
    const inPlace = keepScroll(router);
    const show = async (url: string) => {
      const target = new URL(url, location.href);
      if (target.origin !== location.origin) {
        throw new Error(`Not this page's origin: ${target.origin}`);
      }
      let loadedSince: number | null = null;
      if (target.href !== location.href) {
        const res = await fetch(target.href, {
          headers: { accept: "text/html" },
          credentials: "same-origin",
          cache: "no-store",
        });
        await res.body?.cancel();
        if (!res.ok) throw new Error(`The page answered ${res.status}`);
        loadedSince = Date.now();
        await router.navigate({
          href: `${target.pathname}${target.search}${target.hash}`,
          replace: true,
          resetScroll: false,
        });
      }
      if (loadedSince === null) return router.invalidate();
      const since = loadedSince;
      const stale = router.state.matches.filter((m) => m.updatedAt < since);
      if (stale.length === 0) return;
      const ids = new Set(stale.map((m) => m.id));
      await router.invalidate({ filter: (m) => ids.has(m.id) });
    };
    const refresh: StudioPageRefresh = (url) => inPlace(() => show(url));
    const slot = window as unknown as Record<string, unknown>;
    slot[STUDIO_PAGE_REFRESH] = refresh;
    return () => {
      if (slot[STUDIO_PAGE_REFRESH] === refresh) delete slot[STUDIO_PAGE_REFRESH];
    };
  }, [router]);

  return null;
}
