/** Automatic error capture.
 *
 *  `captureException` in core only ever sees what a site already wrapped in try/catch,
 *  which is the minority of what breaks. This module attaches the two listeners that
 *  see the rest, and does the two things that separate an error product from an error
 *  log: it gives every error a stable fingerprint so repeats group, and it collapses a
 *  repeating error into one event with a count instead of one event per occurrence.
 *
 *  That second part is not an optimisation. A render loop throwing on every frame is
 *  the normal shape of a bad deploy; without collapsing, one visitor's broken tab sends
 *  thousands of events, the queue drops the rest of their session, and the bill and the
 *  data are both wrong.
 */
import { LIMITS } from "../../shared/contract.ts";

type Props = Record<string, string | number | boolean>;

window.__dqRegister?.((enqueue, api: Record<string, unknown>, onFinal) => {
  // Volatile parts of a message are what stop repeats grouping: ids, timestamps, URLs
  // and offsets differ per occurrence while the fault is identical. Strip them before
  // hashing, keep the original message on the event as a sample.
  const stable = (msg: string) =>
    msg
      .replace(/https?:\/\/[^\s)'"]+/g, "<url>")
      .replace(/\b[0-9a-f]{8,}\b/gi, "<hex>")
      .replace(/\b\d[\d.,]*\b/g, "<n>")
      .replace(/['"][^'"]{0,80}['"]/g, "<str>")
      .slice(0, 200);

  // A file path is the same fault whether it arrives absolute, with a cache-busting
  // query, or with a hash fragment.
  const cleanFile = (f: string) => {
    if (!f) return "";
    try {
      const u = new URL(f, location.href);
      return (u.origin === location.origin ? "" : u.origin) + u.pathname;
    } catch {
      return f.split("?")[0].split("#")[0];
    }
  };

  // A URL in a message or a stack keeps its origin and path and loses its query and fragment:
  // `fetch failed for /api/cart?email=...&token=...` is the fault, the values are a visitor's.
  // A frame's trailing `:line:col` survives, since it is what points at the fault.
  const noQuery = (s: string) =>
    s.replace(
      /([a-z][\w+.-]*:\/\/[^\s?#()'"]*)[?#][^\s()'"]*?(?=:\d+:\d+(?![^\s)])|[\s()'"]|$)/gi,
      "$1",
    );

  // FNV-1a with a murmur3 finaliser. The finaliser matters: without it the low bits are
  // just an XOR of the input's low bits, and near-identical inputs land in adjacent
  // buckets rather than spread.
  const fingerprint = (parts: string[]) => {
    let h = 2166136261;
    const s = parts.join("|");
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^ (h >>> 16)) >>> 0).toString(36).padStart(7, "0");
  };

  // Seen this page load: fingerprint -> how many times since the last send. A repeating
  // error increments rather than enqueues.
  const seen = new Map<string, { n: number; sent: boolean }>();
  // A hard ceiling on DISTINCT errors per page load. A loop that generates a new
  // fingerprint each time (a message with an unstrippable varying part) would otherwise
  // defeat the collapsing entirely, which is the failure mode this guard exists for.
  const MAX_DISTINCT = 20;

  // OURS = this origin, or a host the site declared as its own in `errorHosts` (served as `er`;
  // a separate asset CDN, say). Everything else on a storefront is a vendor: a GTM tag, a pixel,
  // a chat widget. Measured on FILA, New Balance and Umbro, 96-100% of `$error` was a
  // cross-origin ResourceError -- a dead tag, a 403'd account, an ad blocker -- none of it
  // actionable here, and between them 18-26% of every event those sites sent.
  const ours = (u: string) => {
    try {
      const x = new URL(u, location.href);
      return (
        x.origin === location.origin || ((api.er as string[] | undefined) ?? []).includes(x.host)
      );
    } catch {
      return false;
    }
  };

  function report(
    type: string,
    message: string,
    file: string,
    line: number,
    stack: string,
    props?: Props,
  ) {
    // Read by the heatmap module: a click followed by an error within a second is an
    // "error click". On the performance timeline, which is what the click is timed on.
    // Only OUR faults flag it. Vendor tags boot on the storefront's first interaction, so their
    // failures land right after the first click -- every header "error click" reproduced on
    // FILA, New Balance and Umbro was one. The source is the file, else the first stack frame
    // (a URL followed by :line:col, which a URL quoted in the message is not). "Script error."
    // and a fault with no source cannot be attributed, so they do not flag.
    const src = file || (/([a-z][\w+.-]*:\/\/[^\s()]+):\d+:\d+/i.exec(String(stack))?.[1] ?? "");
    // Not the site's code at all: a script the BROWSER injected -- an in-app browser's bridge
    // (`iabjs://`, Instagram/Facebook), an extension (`chrome-extension://`, `moz-extension://`,
    // `safari-web-extension://`). Nothing the site ships can fix it, and it was the largest single
    // fault on two storefronts after #27 (newbalance: 130 an hour, "Error invoking postMessage:
    // Java object is gone").
    if (/^[a-z][\w+.-]*:\/\//i.test(src) && !/^https?:/i.test(src)) return;
    if (src && message !== "Script error." && ours(src))
      (window as any).__dqLastErrorTs = performance.now();
    const fp = fingerprint([type, stable(message), cleanFile(file), String(line)]);
    const prev = seen.get(fp);
    if (prev) {
      prev.n++;
      return;
    } // already reported this page load
    if (seen.size >= MAX_DISTINCT) return; // storm guard
    seen.set(fp, { n: 1, sent: true });

    enqueue("$error", props, {
      error_type: (type || "Error").slice(0, 40),
      error_fingerprint: fp,
      error_message: noQuery(String(message ?? "")).slice(0, LIMITS.valueLen),
      error_file: cleanFile(file).slice(0, LIMITS.pathLen),
      error_line: Number(line) || 0,
      error_count: 1,
      error_stack: noQuery(String(stack ?? "")).slice(0, LIMITS.errorEventBytes),
    });
  }

  // Repeats accumulated after the first report are sent once, at the end, as a single
  // event carrying the count. One event per thousand occurrences, and the thousand is
  // still visible.
  function flushRepeats() {
    let any = false;
    for (const [fp, rec] of seen) {
      if (rec.n <= 1) continue;
      enqueue("$error", undefined, {
        error_fingerprint: fp,
        error_type: "repeat",
        error_count: rec.n - 1,
        error_message: "",
      });
      rec.n = 1;
      any = true;
    }
    void any;
  }
  // Ordering, not a second request: core runs this BEFORE its final flush, so the
  // repeats are in the queue when that flush happens. Enqueueing after it used to
  // report eight occurrences as one; flushing again to compensate cost a request.
  onFinal(flushRepeats);

  addEventListener(
    "error",
    (e: any) => {
      // A failed <img>/<script>/<link> also fires "error" on window, with no `error`
      // object and the element as target. It is a real fault worth recording, but it is
      // not an exception and must not be reported as one.
      if (!e?.error && e?.target && e.target !== window) {
        const el = e.target;
        // `.href` on an SVG element is an SVGAnimatedString, NOT a string — so a failing
        // `<use href="/sprite.svg#icon">` used to be reported as
        // `/[object%20SVGAnimatedString]`, which names no resource and masks which sprite
        // actually failed (seen live on a storefront whose icons are one `<use>` sprite).
        // `.src` has the same shape on SVGScriptElement.
        const raw = el.src || el.href || "";
        const src: string = typeof raw === "string" ? raw : (raw.baseVal ?? "");
        // A vendor's asset failing is the vendor's problem (see `ours`): dropped, not reported.
        // Ours -- our chunks, our sprite, a declared `errorHosts` CDN -- is a real fault.
        if (!src || !ours(src)) return;
        report(
          "ResourceError",
          `failed to load ${el.tagName?.toLowerCase?.() ?? "resource"}`,
          src,
          0,
          "",
        );
        return;
      }
      report(
        e?.error?.name ?? "Error",
        e?.message ?? String(e?.error ?? "error"),
        e?.filename ?? "",
        e?.lineno ?? 0,
        e?.error?.stack ?? "",
      );
    },
    true,
  ); // capture phase: resource errors do not bubble

  addEventListener("unhandledrejection", (e: any) => {
    const r = e?.reason;
    report(
      r?.name ?? "UnhandledRejection",
      r?.message ?? String(r ?? "rejected"),
      r?.fileName ?? "",
      r?.lineNumber ?? 0,
      r?.stack ?? "",
    );
  });

  // Same fingerprinting for the manual path, so an error caught by the site and the
  // same error escaping uncaught land in one group rather than two.
  api.captureException = (err: any, props?: Props) =>
    report(
      err?.name ?? "Error",
      err?.message ?? String(err),
      err?.fileName ?? "",
      err?.lineNumber ?? 0,
      err?.stack ?? "",
      props,
    );
});
