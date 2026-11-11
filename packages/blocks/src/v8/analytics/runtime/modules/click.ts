/** A/B testing interaction capture: per-click telemetry for whichever elements a site
 *  wants scored against an experiment variant.
 *
 *  Not tied to a specific experiment id in the payload -- `enqueue` already merges
 *  `cfg.x` (the map `setExperiment` builds) into every event, so `exp` on this row is
 *  free. Carrying it again here would duplicate a column this event already gets by
 *  riding the same pipe as everything else.
 *
 *  `engagement.ts` already tracks outbound/download clicks unconditionally, because
 *  those are a fixed, small vocabulary. Clicks in general are not: GA4 sends one event
 *  per click with no cap, which is the shape this module exists to avoid repeating.
 */
import { LIMITS } from "../../shared/contract.ts";

const CAPTURE_PHASE: Record<number, string> = {
  1: "capturing",
  2: "at_target",
  3: "bubbling",
};

window.__dqRegister?.((enqueue) => {
  // Same reasoning as engagement's outbound cap: an experiment CTA rage-clicked ten
  // times is one fact about that click, not ten rows.
  const MAX_CLICKS = 30;
  let sent = 0;

  addEventListener(
    "click",
    (event: MouseEvent) => {
      if (sent >= MAX_CLICKS) return;
      const el = event.target as Element | null;
      if (!el) return;
      sent++;

      const classList = el.classList ? [...el.classList].slice(0, 5).join(" ") : "";

      enqueue("experiment_click", {
        capture_phase: CAPTURE_PHASE[event.eventPhase] ?? "none",
        // Viewport, for reading `page_x`/`page_y` as a fraction of what the visitor could
        // actually see -- document size, not screen size, is a separate question nobody
        // asked here.
        viewport_width: window.innerWidth || document.documentElement.clientWidth || 0,
        viewport_height: window.innerHeight || document.documentElement.clientHeight || 0,
        page_x: Math.round(event.pageX),
        page_y: Math.round(event.pageY),
        element_type: el.tagName?.toLowerCase() ?? "",
        element_id: el.id ?? "",
        element_class: classList.slice(0, LIMITS.valueLen),
        is_trusted: event.isTrusted,
      });
    },
    { capture: true, passive: true },
  );
});
