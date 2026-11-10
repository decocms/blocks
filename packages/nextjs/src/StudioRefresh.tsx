"use client";
/**
 * The page's own refresh for Studio's HTML swap (`STUDIO_PAGE_REFRESH`): after
 * a save, Studio asks the page to show its new content. Replacing the document
 * would leave React holding the old nodes, so every client component (a footer
 * revealed on scroll, a carousel, a popup) would stop at its server markup.
 * Here the App Router does it instead: `router.refresh()` for the page's own
 * URL, `router.replace()` for a new one (a save moved the draft pointer in
 * `?__draft=`), both re-rendering the Server Components with React attached.
 * The promise resolves when the transition is over, so Studio's progress bar
 * runs as long as the refresh.
 *
 * Set on every page, framed or not: Studio's module is the only caller, and
 * comparing the window with its parent here is what a test runner's
 * frame-busting rewrite matches (see `StudioBridge.ts`).
 */
import { useRouter } from "next/navigation";
import { useEffect, useRef, useTransition } from "react";
import { STUDIO_PAGE_REFRESH } from "./studio.ts";

type StudioPageRefresh = (url: string) => Promise<void>;

export function StudioRefresh(): null {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Each refresh waits for the transition it starts; a later one joins it.
  const waiting = useRef<Array<() => void>>([]);

  useEffect(() => {
    if (pending) return;
    for (const resolve of waiting.current.splice(0)) resolve();
  }, [pending]);

  useEffect(() => {
    const refresh: StudioPageRefresh = (url) =>
      new Promise<void>((resolve, reject) => {
        let target: URL;
        try {
          target = new URL(url, location.href);
        } catch (error) {
          reject(error);
          return;
        }
        if (target.origin !== location.origin) {
          reject(new Error(`Not this page's origin: ${target.origin}`));
          return;
        }
        waiting.current.push(resolve);
        startTransition(() => {
          if (target.href === location.href) router.refresh();
          else
            router.replace(`${target.pathname}${target.search}${target.hash}`, { scroll: false });
        });
      });
    const slot = window as unknown as Record<string, unknown>;
    slot[STUDIO_PAGE_REFRESH] = refresh;
    return () => {
      if (slot[STUDIO_PAGE_REFRESH] === refresh) delete slot[STUDIO_PAGE_REFRESH];
    };
  }, [router]);

  return null;
}
