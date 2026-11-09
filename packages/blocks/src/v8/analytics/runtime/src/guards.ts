/** Reasons not to collect at all, evaluated once at boot.
 *
 *  Automation detection has a catch: Playwright sets navigator.webdriver, so it would
 *  block our own end-to-end tests. `__dqAllowAutomation` is the escape hatch, and it is
 *  why 2.8 does not fail for the wrong reason. */
export function shouldSkip(w: typeof globalThis & Record<string, any>): string | null {
  const nav = w.navigator;

  if (!w.__dqAllowAutomation) {
    if (nav?.webdriver) return "automation";
    if (w._phantom || w.__nightmare || w.Cypress) return "automation";
  }

  try {
    if (w.localStorage?.getItem("__dq_ignore") === "true") return "opt-out";
  } catch {
    /* storage can throw in private mode; not a reason to skip */
  }

  if (isLocal(w) && !w.__dq?.dev) return "local";

  return null;
}

/** A development host. Not collected unless the site asks for it.
 *
 *  This was missing entirely, and on a fleet of storefronts built by agencies that is not
 *  a small omission: every `npm run dev` against a client's site was writing into that
 *  client's production numbers, indistinguishable from real traffic. Plausible ships a
 *  separate script variant for the local case and OneDollarStats has `data-devmode`,
 *  because both meet the same problem.
 *
 *  Opt in with `window.__dq.dev = true` before the script loads. */
function isLocal(w: typeof globalThis & Record<string, any>): boolean {
  const l = w.location;
  if (!l) return false;
  if (l.protocol === "file:") return true;
  const h = String(l.hostname ?? "");
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h === "[::1]" ||
    h.endsWith(".local") ||
    h.endsWith(".localhost") ||
    // The private ranges a dev server binds to when someone tests from a phone.
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

/** A page prerendered by Chrome must not count until it becomes visible. Without this any
 *  site with prefetch overcounts — which is the whole fleet. */
export function whenVisible(doc: Document, fn: () => void): void {
  if ((doc as any).prerendering) {
    doc.addEventListener("prerenderingchange", () => fn(), { once: true });
    return;
  }
  if ((doc.visibilityState as string) === "prerender") {
    doc.addEventListener("visibilitychange", function onVis() {
      if ((doc.visibilityState as string) !== "prerender") {
        doc.removeEventListener("visibilitychange", onVis);
        fn();
      }
    });
    return;
  }
  fn();
}
