/**
 * Push campaigns as CMS content.
 *
 * The insight this is built on: **a push campaign is a decofile block with a
 * matcher rule.** Everything Studio needs to author one already exists —
 * `generate-schema` turns a `Props` interface into a form, matchers compose
 * with `multi`/`negate`, and a saved matcher block is reusable across
 * campaigns. So this module adds types and audience matchers, not a new
 * authoring system.
 *
 * ```jsonc
 * // .deco/blocks/push-carrinho-abandonado.json
 * {
 *   "__resolveType": "site/push/Campaign.tsx",
 *   "title": "Seu carrinho está esperando",
 *   "body": "Finalize sua compra e ganhe frete grátis",
 *   "url": "/checkout",
 *   "audience": {
 *     "__resolveType": "website/matchers/multi.ts",
 *     "op": "and",
 *     "matchers": [
 *       { "__resolveType": "native/matchers/cartAge.ts", "minHours": 4 },
 *       { "__resolveType": "native/matchers/lastOpen.ts", "minDays": 1 }
 *     ]
 *   }
 * }
 * ```
 *
 * ## What this module is not
 *
 * It does not deliver. APNs/FCM/Expo Push is a provider choice, and a bad one
 * to bake into a framework — `send` is injected. It also does not schedule:
 * *when* to run a sweep is the site's cron, and this only answers "given these
 * campaigns and this device, right now, which fire?".
 *
 * ## Frequency capping is deliberate, not incidental
 *
 * A campaign that matches every sweep would notify the same device every few
 * minutes, which is how an app gets uninstalled. `cooldownHours` is required
 * rather than optional for that reason, and `selectCampaigns` will not return
 * a campaign the device was already sent inside its window.
 */

import { evaluateMatcher, registerMatcher } from "@decocms/blocks/cms";
import { registerBuiltinMatchers } from "@decocms/blocks/matchers/builtins";

/** A device that registered for push, plus the state campaigns target. */
export interface DeviceSnapshot {
  /** Provider token (Expo push token, FCM/APNs id). Opaque here. */
  token: string;
  platform: "ios" | "android";
  /** Epoch ms of the last app open. */
  lastOpenedAt?: number;
  /** Epoch ms the current cart was last modified, if any. */
  cartUpdatedAt?: number;
  cartItemCount?: number;
  /** Whether the device belongs to a signed-in user. */
  signedIn?: boolean;
  /** Free-form segments the app assigns (`vip`, `beta`, …). */
  tags?: string[];
  /** Campaign id → epoch ms it was last delivered. Drives cooldown. */
  lastSentAt?: Record<string, number>;
}

/** A campaign block, as authored in Studio. */
export interface PushCampaign {
  /** Stable id. Used for frequency capping — changing it re-notifies everyone. */
  id: string;
  /** @title Título da notificação */
  title: string;
  /** @title Mensagem */
  body: string;
  /**
   * @title Link
   * @description Caminho do site para abrir ao tocar (`/checkout`, `/products/x`).
   * Passa pela política de rota do app, então abre nativo se houver tela.
   */
  url?: string;
  /** Who receives it. Any matcher, including the native ones below. */
  audience?: Record<string, unknown>;
  /**
   * @title Não repetir por (horas)
   * @description Required on purpose: a campaign with no cap notifies the same
   * device every sweep, which is how an app gets uninstalled.
   */
  cooldownHours: number;
  /** @title Ativa */
  enabled?: boolean;
}

export interface SelectedCampaign {
  campaign: PushCampaign;
  device: DeviceSnapshot;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Reads a numeric rule field, tolerating the strings a JSON form produces. */
const num = (value: unknown): number | undefined => {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
};

const snapshotOf = (ctx: { state?: Record<string, unknown> }) =>
  (ctx.state?.device ?? undefined) as DeviceSnapshot | undefined;

/**
 * Registers the audience matchers.
 *
 * They go through the same `registerMatcher` the built-ins use, so they
 * compose with `multi`/`negate`, can be saved as reusable blocks, and are
 * evaluated by the same `evaluateMatcher` — which fails closed on a throw.
 * Call once at boot, wherever campaigns are evaluated.
 */
export function registerPushMatchers(now: () => number = Date.now): void {
  // Composition is the point — an audience is normally `multi`/`negate` over
  // these. But only always/never/device/random/date auto-register; the rest
  // need this call. Forgetting it fails SILENTLY: the audience never matches,
  // the campaign never sends, and nothing logs. Pull them in here so that is
  // not possible.
  registerBuiltinMatchers();

  /** Days since the app was last opened. The "we miss you" campaign. */
  registerMatcher("native/matchers/lastOpen.ts", (rule, ctx) => {
    const device = snapshotOf(ctx);
    if (!device?.lastOpenedAt) return false;
    const days = (now() - device.lastOpenedAt) / DAY;
    const min = num(rule.minDays);
    const max = num(rule.maxDays);
    if (min !== undefined && days < min) return false;
    if (max !== undefined && days > max) return false;
    return true;
  });

  /** An abandoned cart: items present and untouched for a while. */
  registerMatcher("native/matchers/cartAge.ts", (rule, ctx) => {
    const device = snapshotOf(ctx);
    if (!device?.cartUpdatedAt || !(device.cartItemCount ?? 0)) return false;
    const hours = (now() - device.cartUpdatedAt) / HOUR;
    const min = num(rule.minHours);
    const max = num(rule.maxHours);
    if (min !== undefined && hours < min) return false;
    if (max !== undefined && hours > max) return false;
    return true;
  });

  registerMatcher("native/matchers/platform.ts", (rule, ctx) => {
    const device = snapshotOf(ctx);
    if (!device) return false;
    // No flag set matches everything — same permissive default as the built-in
    // device matcher.
    if (!rule.ios && !rule.android) return true;
    return Boolean(rule[device.platform]);
  });

  registerMatcher("native/matchers/signedIn.ts", (rule, ctx) => {
    const device = snapshotOf(ctx);
    if (!device) return false;
    return Boolean(device.signedIn) === (rule.signedIn !== false);
  });

  registerMatcher("native/matchers/tag.ts", (rule, ctx) => {
    const device = snapshotOf(ctx);
    const tag = typeof rule.tag === "string" ? rule.tag : undefined;
    if (!device || !tag) return false;
    return (device.tags ?? []).includes(tag);
  });
}

/** True when the device is still inside this campaign's cooldown. */
export function isCoolingDown(
  campaign: PushCampaign,
  device: DeviceSnapshot,
  now = Date.now(),
): boolean {
  const last = device.lastSentAt?.[campaign.id];
  if (last === undefined) return false;
  return now - last < campaign.cooldownHours * HOUR;
}

/**
 * Which campaigns fire, for which devices, right now.
 *
 * Pure: no clock of its own beyond `now`, no delivery, no persistence. The
 * caller sweeps devices on its own schedule and records what it sent.
 */
export function selectCampaigns(
  campaigns: PushCampaign[],
  devices: DeviceSnapshot[],
  now = Date.now(),
): SelectedCampaign[] {
  const active = campaigns.filter((c) => c.enabled !== false && c.cooldownHours > 0);
  const selected: SelectedCampaign[] = [];

  for (const device of devices) {
    for (const campaign of active) {
      if (isCoolingDown(campaign, device, now)) continue;
      // Same evaluator the CMS uses: saved matcher blocks resolve, multi/negate
      // compose, and a throwing matcher excludes the device rather than the
      // campaign — a push is not worth an exception.
      if (!evaluateMatcher(campaign.audience, { state: { device } })) continue;
      selected.push({ campaign, device });
    }
  }

  return selected;
}
