/** Consent, and the stable identifier it unlocks.
 *
 *  At tier 0 — the default, and what every site runs today — there is no consent to ask
 *  for and nothing here does anything. Identity is an HMAC over a salt the Worker rotates
 *  and deletes every day, which is what makes the collector cookieless and is the same
 *  design Plausible ships. Its cost is that the same person is a new identifier tomorrow,
 *  so retention cannot be measured at all.
 *
 *  Tier 1 buys that back, and only where a visitor has actually agreed. We deliberately do
 *  NOT ship a banner: every serious storefront already runs a CMP — farmrio loads OneTrust,
 *  898 KB of it — and a second prompt would ask the visitor twice while leaving it
 *  ambiguous which consent governs. So this listens for the consent that already exists
 *  and adds an explicit call for sites whose banner is homegrown.
 *
 *  Three sources, in the order a site is likely to have them:
 *    1. `__dq.consent(true|false)` — explicit, and always wins
 *    2. IAB TCF v2 `__tcfapi` — what OneTrust and Cookiebot expose
 *    3. Google Consent Mode — `analytics_storage` on the dataLayer, for GTM sites
 */

const KEY = "_dq_cid";

type Listener = (granted: boolean) => void;
const listeners: Listener[] = [];
let granted: boolean | null = null; // null = not yet known, which is not "no"

/** A random identifier, not derived from anything about the visitor. It is a label the
 *  browser carries, so it can be deleted by the visitor and is meaningless anywhere else.
 *  The Worker hashes it with the site before storing, so the same browser is a different
 *  identifier on each customer's site — without that we would have built the cross-client
 *  identity graph that tier 0 exists to avoid. */
function mint(): string {
  const b = new Uint8Array(16);
  (globalThis.crypto ?? ({} as Crypto)).getRandomValues?.(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function store(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  } // blocked in some privacy modes
}

/** The stable id, or "" when there is no consent. Reading this never creates one: an id
 *  minted before consent arrived is a persistent identifier set without permission, which
 *  is the exact thing consent is being asked about. */
export function clientId(): string {
  if (granted !== true) return "";
  const s = store();
  if (!s) return "";
  let v = "";
  try {
    v = s.getItem(KEY) ?? "";
  } catch {
    return "";
  }
  if (!v || v.length !== 32) {
    v = mint();
    try {
      s.setItem(KEY, v);
    } catch {
      return "";
    }
  }
  return v;
}

/** Withdrawal has to erase, not merely stop sending. A visitor who says no and still finds
 *  the identifier in their browser was not given a choice, they were given a checkbox. */
function forget() {
  try {
    store()?.removeItem(KEY);
  } catch {
    /* nothing to do about it */
  }
}

export function setConsent(v: boolean) {
  if (granted === v) return;
  granted = v;
  if (!v) forget();
  for (const fn of listeners) {
    try {
      fn(v);
    } catch {
      /* one listener must not stop another */
    }
  }
}

export function onConsent(fn: Listener) {
  listeners.push(fn);
}
export function consentKnown(): boolean {
  return granted !== null;
}

/** Wires up whichever CMP is present. Safe to call when none is: every branch is guarded,
 *  and a site with no banner simply never grants, which leaves it at tier 0. */
export function watchConsent(w: any) {
  // 1. Google Consent Mode. GTM sites push `['consent', 'update', {analytics_storage}]`,
  //    and the state may already be on the dataLayer before we load.
  const dl = w.dataLayer;
  if (Array.isArray(dl)) {
    const read = (a: any) => {
      if (a?.[0] === "consent" && (a[1] === "update" || a[1] === "default") && a[2]) {
        if (a[2].analytics_storage === "granted") setConsent(true);
        else if (a[2].analytics_storage === "denied") setConsent(false);
      }
    };
    for (const a of dl) read(a);
    const push = dl.push.bind(dl);
    dl.push = function (...args: any[]) {
      try {
        read(args[0]);
      } catch {
        /* keep GTM working */
      }
      return push(...args);
    };
  }

  // 2. IAB TCF v2. Purpose 1 is "store and access information on a device", which is
  //    exactly what an identifier in localStorage is — not purpose 8 (measurement), which
  //    covers what we do with it once stored.
  if (typeof w.__tcfapi === "function") {
    try {
      w.__tcfapi("addEventListener", 2, (data: any, ok: boolean) => {
        if (!ok || !data) return;
        if (data.eventStatus !== "tcloaded" && data.eventStatus !== "useractioncomplete") return;
        setConsent(Boolean(data.purpose?.consents?.[1]));
      });
    } catch {
      /* a CMP that throws is a CMP that has not granted */
    }
  }
}

// Registered like every other module: core exposes the hook, this fills it in. A site at
// tier 0 downloads none of this — the same rule that keeps `commerce` off a blog.
window.__dqRegister?.((_enqueue, api: Record<string, unknown>) => {
  watchConsent(window as any);
  (window as any).__dqCid = clientId;
  // Overrides the core no-op, so a homegrown banner has something to call.
  api.consent = (v: unknown) => setConsent(Boolean(v));
});

export const CONSENT_KEY = KEY;
