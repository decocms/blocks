import {
  LIMITS,
  WIRE,
  CAMPAIGN_KEYS,
  campaignKey,
  isSampleable,
  type Props,
} from "../../shared/contract.ts";
import { trimProps } from "./trim.ts";
import { BoundedQueue, type QueuedEvent } from "./queue.ts";
import { shouldSkip, whenVisible } from "./guards.ts";

type Cfg = {
  s: string; // site id
  k?: string; // self-serve key, when not resolved from Host
  r?: number; // sampling
  tier?: 0 | 1; // 1 = a stable id is allowed, WITH consent
  hash?: boolean; // the site routes on location.hash
  dev?: boolean; // collect even on a development host
  x?: Record<string, string>; // experiment map, injected by SSR
  e?: string; // endpoint
  q?: unknown[] | { push: (r: unknown) => void }; // stub queue; a live dispatcher after boot
  killed?: boolean;
  hr?: number; // heatmap module: per-view sampling rate
  er?: string[]; // errors module: cross-origin hosts that count as ours
  h?: number; // heatmap module: 0 = switched off by the server
};

const w = globalThis as typeof globalThis & Record<string, any>;
const cfg: Cfg = w.__dq ?? (w.__dq = { s: "unknown" });
/** Config carried on the script tag itself, read before anything else.
 *
 *  Instrumenting a real TanStack storefront found the hazard this exists for: the
 *  framework hoisted `<script async src=".../_dq/a.js">` into `<head>`, ABOVE the inline
 *  block that was supposed to configure it — measured at byte 190 against byte 1108. The
 *  collector therefore ran with no `dev` flag, `shouldSkip` correctly saw a development
 *  host, and boot returned early. The only symptom was silence, and `window.__dq` looked
 *  half-built afterwards.
 *
 *  An attribute cannot lose that race: it is on the element that is executing. This is
 *  why OneDollarStats carries `data-hostname` and `data-devmode` rather than expecting a
 *  global to be there first, and it is the shape `<Stats />` (6.3) has to ship. */
const tag = (() => {
  try {
    return (
      (document.currentScript as HTMLScriptElement | null) ??
      document.querySelector<HTMLScriptElement>('script[src*="/_dq/a.js"]')
    );
  } catch {
    return null;
  }
})();
const attr = (n: string) => tag?.dataset?.[n];

/** Where beacons go.
 *
 *  Derived from the SCRIPT'S OWN src, not from a relative path. Instrumenting a real
 *  storefront found why: the tag was loaded from our collector, the beacon used `/_dq/e`,
 *  and a relative path resolves against the PAGE's origin — so every event was posted to
 *  the shop's own server, which answered 200 with its homepage. Nothing reached the
 *  collector and nothing reported an error, because a 200 is a 200.
 *
 *  A site on our CDN is unaffected, since both are the same origin; that is exactly why
 *  this survived every local test. It breaks for every site that is NOT on our CDN — the
 *  self-serve tier, which is the whole reason the `?k=` path exists.
 *
 *  An explicit `cfg.e` still wins, and the relative path remains the last resort. */
const ENDPOINT = (() => {
  if (cfg.e) return cfg.e;
  try {
    const src = tag?.src;
    if (src) return new URL("/_dq/e", src).toString();
  } catch {
    /* a src we cannot parse is not a reason to fail to collect */
  }
  return "/_dq/e";
})();

const queue = new BoundedQueue();
let superProps: Record<string, string> = {};
let optedOut = false;
/** Readable from config so it is on BEFORE boot. The skip reason — "local", "opt-out",
 *  "automation" — is logged during boot, so a flag that can only be set by calling a
 *  method afterwards cannot explain the one failure it exists for: nothing arrives and
 *  there is no way to tell whether the tag is wrong, the site is wrong, or the host is
 *  excluded. OneDollarStats reaches the same conclusion with `data-devmode`. */

if (attr("dev") !== undefined)
  (w as any).__dq = Object.assign((w as any).__dq ?? {}, { dev: attr("dev") !== "false" });
if (attr("debug") !== undefined)
  (w as any).__dq = Object.assign((w as any).__dq ?? {}, { debug: attr("debug") !== "false" });

let skipped = false;
let debugOn = Boolean((w as any).__dq?.debug);
let timer: number | undefined;
let firstSent = false;

/** Run just before the last flush of a page load, so a module can add what it only knows
 *  at the end without spending a request of its own. */
const finalHooks: Array<() => void> = [];
/** Run when an SPA navigation changes the URL, BEFORE the new `$pageview`, with the path that
 *  is being left. A module measuring "this view" closes it here, so route 2 does not inherit
 *  route 1's scroll depth -- which is exactly what `$scroll` did before this existed. */
const routeHooks: Array<(prev: string) => void> = [];

const log = (...a: unknown[]) => debugOn && console.log("[dq]", ...a);
const uuidv7 = (): string => {
  // Time-ordered so replay dedups by a key that also sorts, without pulling a dependency.
  const t = Date.now();
  const hex = t.toString(16).padStart(12, "0");
  const r = crypto.getRandomValues(new Uint8Array(10));
  const h = [...r].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${h.slice(0, 3)}-${(
    (parseInt(h[3], 16) & 0x3) | 0x8
  ).toString(16)}${h.slice(4, 7)}-${h.slice(7, 19)}`;
};

function enqueue(
  rawName: unknown,
  rawProps: unknown,
  extra?: Record<string, unknown>,
  urgent = false,
) {
  if (optedOut || cfg.killed) return;
  // Only the tail is sheddable. `$` events carry every core metric and are bounded per
  // pageview anyway, so exempting them costs almost no volume and keeps visitor counts,
  // sessions and vitals exact at any rate.
  if (
    typeof cfg.r === "number" &&
    cfg.r < 1 &&
    isSampleable(String(rawName ?? "")) &&
    Math.random() > cfg.r
  )
    return;

  // Only the two violations that cost upload bytes are caught here; the Worker owns the
  // rest, including the event name. Sending a name unnormalised costs nothing and saves
  // 2.3 KB of normaliser in every visitor's download.
  const trunc = new Set<string>();
  const props = trimProps({ ...superProps, ...((rawProps as object) ?? {}) }, (f) => trunc.add(f));
  const name = String(rawName ?? "").slice(0, LIMITS.nameLen * 2);

  // Short keys on the wire. Field names are a double-digit share of a ~293 byte event, and
  // the visitor pays that upload — often on mobile data. The Worker expands them, so
  // nothing downstream ever sees the abbreviation.
  const e: QueuedEvent = {
    [WIRE.event_id]: uuidv7(),
    [WIRE.ts]: new Date().toISOString(),
    [WIRE.name]: name,
    [WIRE.path]: location.pathname.slice(0, LIMITS.pathLen),
    [WIRE.props]: props,
  };
  if (document.referrer) e[WIRE.referrer] = document.referrer.slice(0, LIMITS.refLen);
  // On EVERY event of the page load, not just the landing pageview: an event fired
  // after a client-side route change still belongs to the campaign that brought the
  // visitor, and by then the query string is long gone.
  if (hasCampaign) e[WIRE.utm] = campaign;
  // Installed by the consent module, which only tier-1 sites download. Core asks; it does
  // not know what consent is, the same way it does not know what a cart is.
  const ci = (w as any).__dqCid?.();
  if (ci) e[WIRE.client_id] = ci;
  if (cfg.x && Object.keys(cfg.x).length) e[WIRE.exp] = cfg.x;

  // Absent rather than empty: a key that is not sent costs nothing, while an empty one
  // costs its own name on every event.
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined || v === null || v === "") continue;
      const short = (WIRE as Record<string, string>)[k];
      e[short ?? k] = v;
    }
  }
  if (trunc.size) e[WIRE._trunc] = [...trunc];

  queue.push(e);
  // The FIRST event of a page load goes immediately; everything after it batches.
  //
  // End-to-end latency measured 8.3s and none of it was the warehouse — ClickHouse answers
  // in milliseconds. It was this queue: an event waits up to flushMs before anyone can see
  // it, which makes a realtime view structurally impossible however fast the read side is.
  //
  // Flushing only the first costs ONE extra request per page load rather than one per
  // event, so the batching that protects the collector is untouched — and the first event
  // is the one realtime needs, because it is the pageview saying a visitor arrived.
  if (!firstSent) {
    firstSent = true;
    flush();
    return;
  }

  // Some events must not wait, and CORE DOES NOT DECIDE WHICH. This started as a name
  // check here -- `name === "purchase"` -- which put the word "purchase" in the core
  // bundle and broke the test asserting that a site without the commerce module does not
  // download commerce vocabulary. That test was right: core does not know what a cart is,
  // and the module that owns an event is the only thing that can judge what losing it
  // costs. So urgency arrives as a parameter from the caller.
  if (urgent) {
    flush();
    return;
  }

  log("queued", name, e);
  if (queue.length >= LIMITS.eventsPerBatch) flush();
}

function applyCommand(cmd: Record<string, unknown> | null) {
  if (!cmd) return;
  if (cmd.k) {
    cfg.killed = true;
    log("killed by server");
  }
  if (typeof cmd.r === "number") {
    cfg.r = cmd.r;
    log("sampling ->", cmd.r);
  }
  // Module-level switch: `{h:0}` stops the heatmap module for the rest of the page load
  // without touching core collection.
  if ("h" in cmd) cfg.h = cmd.h as number;
}

const payload = (events: QueuedEvent[]) => JSON.stringify({ site: cfg.s, key: cfg.k, events });

/** The last chance to deliver, so it does not get to fail quietly.
 *
 *  sendBeacon returns false more often than people expect: over the browser's beacon
 *  queue limit, blocked by a connect-src CSP, or simply absent. Some privacy modes throw
 *  instead of returning false. Either way the batch is still in hand, and keepalive fetch
 *  survives unload too — so it is the fallback rather than the primary, which sendBeacon
 *  remains because it is the more reliable of the two during teardown. */
function sendFinal(body: string): void {
  try {
    const blob = new Blob([body], { type: "text/plain" });
    if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, blob)) {
      log("final via sendBeacon", body.length);
      return;
    }
    log("sendBeacon declined, falling back");
  } catch (e) {
    log("sendBeacon threw, falling back", e);
  }

  try {
    fetch(ENDPOINT, {
      method: "POST",
      body,
      keepalive: true,
      headers: { "Content-Type": "text/plain" },
    }).catch(() => {});
    log("final via keepalive fetch", body.length);
  } catch (e) {
    log("both transports failed", e);
  }
}

function flush(final = false) {
  if (final) {
    // Drain everything, not one batch. A tab closing with 120 events queued would
    // otherwise deliver 50 and lose 70 — and nothing would report the loss.
    let batch: QueuedEvent[];
    while ((batch = queue.drain()).length) sendFinal(payload(batch));
    return;
  }

  const batch = queue.drain();
  if (!batch.length) return;

  // text/plain avoids the CORS preflight: application/json cross-origin would trigger an
  // OPTIONS before every beacon and double the request count.
  fetch(ENDPOINT + (debugOn ? "?debug=1" : ""), {
    method: "POST",
    body: payload(batch),
    keepalive: true,
    headers: { "Content-Type": "text/plain" },
  })
    .then((r) => (r.status === 200 ? r.json() : null))
    .then((cmd) => {
      // With debug on the Worker echoes the flags it applied, so a developer sees what was
      // rewritten without querying the warehouse — and without the client carrying the
      // normaliser to find out.
      const c = cmd as { _trunc?: string[] } | null;
      if (c?._trunc && debugOn) console.warn("[dq] server adjusted:", c._trunc);
      applyCommand(c as Record<string, unknown> | null);
    })
    .catch(() => {
      /* losing a batch is not worth breaking the page over */
    });
}

function pageview(props?: Props) {
  enqueue("$pageview", props);
}

/** trimProps accepts primitives and returns them unchanged; superProps is the string map
 *  every event spreads. Narrow here rather than widening superProps. */
/** Campaign parameters live in the query string of the LANDING url and are gone by the
 *  next navigation. Captured once at load and attached to every event in this page load.
 *
 *  Deliberately NOT persisted to storage: keeping them across page loads would need
 *  device storage, which is the one thing that turns a cookieless collector into one
 *  that needs a consent banner. Attribution across the visit is a server-side question
 *  instead — the landing event carries the campaign, and a session inherits it from its
 *  own first event. */
const campaign: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  try {
    const q = new URLSearchParams(location.search);
    for (const raw of CAMPAIGN_KEYS) {
      const v = q.get(raw);
      if (!v) continue;
      const k = campaignKey(raw);
      if (k) out[k] = v.slice(0, 200);
    }
  } catch {
    /* a malformed query string is not worth breaking collection over */
  }
  return out;
})();

const hasCampaign = Object.keys(campaign).length > 0;

const asStrings = (o: Record<string, unknown>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const k in o) out[k] = String(o[k]);
  return out;
};

const api = {
  track: (name: string, props?: Props) => enqueue(name, props),
  pageview,
  // trimProps, not sanitizeProps: the latter has never existed anywhere in the repo. A
  // rename in "one payload contract" (f07c704) missed these two call sites; esbuild
  // treats an unknown identifier as a runtime global rather than an error, and nothing
  // typechecked — so two of the fourteen documented API methods have thrown
  // ReferenceError ever since, silently, because no test called them.
  //
  // The no-op flag sink is deliberate: enqueue() re-trims { ...superProps, ...props } on
  // every event, so anything worth flagging is flagged there with the event it affects.
  // Flagging here as well would attribute it to whichever event happened to be next.
  set: (p: Props) => {
    superProps = { ...superProps, ...asStrings(trimProps(p, () => {})) };
  },
  setOnce: (p: Props) => {
    const clean = asStrings(trimProps(p, () => {}));
    for (const k in clean) if (!(k in superProps)) superProps[k] = clean[k];
  },
  unset: (keys: string[]) => {
    for (const k of keys) delete superProps[k];
  },
  setExperiment: (id: string, variant: string) => {
    cfg.x = { ...(cfg.x ?? {}), [id]: variant };
  },
  variant: (id: string) => cfg.x?.[id],
  captureException: (err: unknown, props?: Props) => {
    const e = err as Error;
    enqueue("$error", props, {
      error_type: e?.name ?? "Error",
      error_message: String(e?.message ?? err).slice(0, LIMITS.valueLen),
      error_stack: (e?.stack ?? "").slice(0, 8000),
    });
  },
  optIn: () => {
    optedOut = false;
    try {
      localStorage.removeItem("__dq_ignore");
    } catch {}
  },
  optOut: () => {
    optedOut = true;
    try {
      localStorage.setItem("__dq_ignore", "true");
    } catch {}
  },
  hasOptedOut: () => optedOut,
  /** Replaced by the consent module on a tier-1 site. Left as a no-op so a site that
   *  calls it at tier 0 does not throw — declining consent that was never asked for is
   *  not an error. */
  consent: (_v: unknown) => {},
  /** Send whatever is queued now. Useful before a hard navigation the SDK cannot see,
   *  such as handing off to a payment provider. */
  flush: () => flush(),
  debug: (on = true) => {
    debugOn = on;
  },
  reset: () => {
    superProps = {};
  },
};

/** The seam optional modules attach to. Core knows how to queue an event and nothing
 *  about what the event means — a module can add named helpers on top without the core
 *  learning what a cart is. */
w.__dqRegister = (
  fn: (
    e: typeof enqueue,
    api: Record<string, unknown>,
    onFinal: (h: () => void) => void,
    onRoute: (h: (prev: string) => void) => void,
  ) => void,
) => {
  // A module must not install its helpers when collection is off. Found on a real
  // storefront: with boot skipped, `window.__dq` carried `addToCart` and
  // `captureException` from the modules while core's own `pageview` and `flush` were
  // absent — a half-built object that invites a site to call into a runtime that will
  // never send. Skipped means skipped, for everyone.
  if (skipped) return;
  try {
    fn(
      enqueue,
      cfg as Record<string, unknown>,
      (h) => {
        finalHooks.push(h);
      },
      (h) => {
        routeHooks.push(h);
      },
    );
  } catch (err) {
    log("module failed", err);
  }
};

/** One call recorded by the stub, replayed against the real API.
 *
 *  Two shapes. `{ m, a }` is the official snippet's: a METHOD and its arguments, so a helper
 *  called before boot (`viewItem`, `purchase`, `captureException`) arrives with its typed columns
 *  -- value, currency, item_ids, transaction_id -- instead of being flattened into props or
 *  dropped. Anything else is the original `track` stub's `[name, props]`, which keeps working.
 *
 *  `replaying` stops the one loop this can make: a method no module provided is still the stub,
 *  and the stub pushes straight back here. That call is dropped, with a debug line saying why. */
let replaying = false;
function replay(r: unknown) {
  if (!r || replaying) {
    if (r) log("no such method; dropped", r);
    return;
  }
  replaying = true;
  try {
    const rec = r as { m?: unknown; a?: ArrayLike<unknown> } & ArrayLike<unknown>;
    if (typeof rec.m === "string") {
      const fn = (cfg as Record<string, unknown>)[rec.m];
      if (typeof fn === "function") fn(...Array.from(rec.a ?? []));
      else log("no such method; dropped", rec.m);
    } else {
      enqueue(rec[0], rec[1]);
    }
  } catch (e) {
    log("replay failed", e);
  } finally {
    replaying = false;
  }
}

function boot() {
  // ONCE PER PAGE, whatever put the tag there.
  //
  // Two identical `<script src>` tags both execute — the browser reuses the cached RESOURCE, not
  // the execution — and measured, that is two `$pageview` events for one page load, doubling
  // every number the page produces. It stopped being hypothetical when the TanStack framework
  // started mounting the tag itself: any site that had already added it by hand now has both,
  // and the duplicate arrives on a dependency bump rather than on a code change anyone reviews.
  //
  // The guard belongs HERE and not in either component, because the component can only know
  // about itself. This covers every way a page ends up with two tags — two components, a
  // component plus a hand-pasted snippet, a tag manager that injects a third.
  //
  // `w` rather than a module-level flag: two copies of this bundle are two module scopes, so a
  // local `let` would be two separate flags, each false.
  if (w.__dqBooted) {
    log("already booted; this tag is a duplicate");
    return;
  }
  w.__dqBooted = true;

  // VIEW MODE: Studio framing this page to draw a heatmap over it. Nothing is collected -- no
  // pageview, no module, no beacon -- and the overlay is a separate chunk that only this branch
  // downloads; every other visitor pays for this test and nothing else. The chunk does the
  // origin handshake: until an allow-listed parent speaks first, it does nothing at all.
  if (/[?&]dq_view=1(&|$)/.test(location.search) && w.top !== w.self) {
    skipped = true;
    const s = document.createElement("script");
    s.src = ENDPOINT.replace(/\/_dq\/e$/, "/_dq/v.js");
    document.head.appendChild(s);
    return;
  }

  const skip = shouldSkip(w);
  if (skip) {
    skipped = true;
    log("not collecting:", skip);
    return;
  }

  const stubbed = (cfg.q ?? []) as unknown[];
  Object.assign(cfg, api);
  // From here on the stub's queue is a live dispatcher, so a stub method a site captured before
  // boot (or one no module replaced) still delivers instead of pushing into an array nobody reads.
  cfg.q = { push: replay };
  // A MICROTASK, because the commerce helpers do not exist yet: modules are appended after core
  // in the same bundle and register when it finishes executing. Replaying here would find
  // `viewItem` still pointing at the stub, which is exactly how a storefront that fires
  // `view_item` before the script loads lost 94% of them.
  queueMicrotask(() => {
    for (const r of stubbed) replay(r);
  });

  whenVisible(document, () => pageview());

  // SPA navigation. The framework serves full documents, but islands and client routers
  // change the URL without one.
  // One notion of "the URL changed", shared by every path that can change it.
  //
  // pushState, popstate and hashchange are not independent events: assigning
  // `location.hash` fires hashchange AND popstate, so a hash-routed site counted every
  // navigation twice — measured, five page views for what was three. Routing all three
  // through here makes a repeat of the same URL a no-op, which also covers the router that
  // calls pushState and then dispatches popstate itself.
  //
  // The hash is part of "the URL" only on a site that routes on it. Elsewhere a click on
  // `#reviews` is an anchor -- and it still fires popstate, so leaving the fragment in the key
  // counted every in-page jump as a page view even with `hash` off.
  const here = () => location.pathname + location.search + (cfg.hash ? location.hash : "");
  let lastUrl = here();
  let lastPath = location.pathname;
  const route = () => {
    const prev = lastPath;
    lastPath = location.pathname;
    for (const fn of routeHooks) {
      try {
        fn(prev);
      } catch {
        /* one module must not stop another */
      }
    }
  };
  const navigated = () => {
    const now = here();
    if (now === lastUrl) return;
    lastUrl = now;
    route();
    pageview();
  };

  const push = history.pushState;
  if (push) {
    history.pushState = function (this: History, ...a: any[]) {
      push.apply(this, a as any);
      navigated();
    } as any;
    addEventListener("popstate", navigated);
  }

  // replaceState was not patched at all, and routers use it constantly — canonical
  // rewrites, redirects, writing filter state into the URL. Only a changed PATH counts
  // here: a PLP rewriting its query string on every filter click is one page view, and
  // firing on each would turn browsing into a traffic spike. This is deliberately stricter
  // than `navigated`, which treats any URL change as a navigation.
  const replace = history.replaceState;
  if (replace) {
    history.replaceState = function (this: History, ...a: any[]) {
      const before = location.pathname;
      replace.apply(this, a as any);
      if (location.pathname !== before) {
        lastUrl = here();
        route();
        pageview();
      }
    } as any;
  }

  // Hash routing, opt-in per site. NOT automatic: on an ordinary page `#secao` is an
  // anchor, and counting those would inflate every long article and every FAQ. A site that
  // routes on the hash declares it — which is how Plausible and OneDollarStats handle it
  // too, each with a mode for the case.
  if (cfg.hash) addEventListener("hashchange", navigated);

  timer = setInterval(() => flush(), LIMITS.flushMs) as unknown as number;

  // Both, on purpose. pagehide misses backgrounding on mobile, and visibilitychange
  // misses some desktop closes; a page can also be restored from bfcache after either.
  // Double-firing is harmless because a drained queue makes the second call a no-op.
  // Modules that only know their value when the page ends — scroll depth, the vitals,
  // the accumulated error repeats — contribute HERE, and then ONE flush carries all of
  // it. Each of them used to call flush() itself, which produced four requests on the
  // way out where one would do: the collector paying per module rather than per visit.
  const onFinal = () => {
    for (const fn of finalHooks) {
      try {
        fn();
      } catch {
        /* one module must not stop another */
      }
    }
    flush(true);
  };
  addEventListener("pagehide", onFinal);
  // On document, not window: visibilitychange is specified to fire at the Document. It
  // does bubble, so a window listener happens to work in a real browser — but relying on
  // that is fragile, and it silently does nothing for any dispatch that is not bubbling.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") onFinal();
  });
}

boot();
export {};
