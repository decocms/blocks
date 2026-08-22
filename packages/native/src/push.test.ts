import { setBlocks } from "@decocms/blocks/cms";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type DeviceSnapshot,
  isCoolingDown,
  type PushCampaign,
  registerPushMatchers,
  selectCampaigns,
} from "./push";

const NOW = Date.parse("2026-08-21T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

beforeEach(() => {
  setBlocks({});
  registerPushMatchers(() => NOW);
});

const device = (over: Partial<DeviceSnapshot> = {}): DeviceSnapshot => ({
  token: "tok",
  platform: "ios",
  ...over,
});

const campaign = (over: Partial<PushCampaign> = {}): PushCampaign => ({
  id: "c1",
  title: "t",
  body: "b",
  cooldownHours: 24,
  ...over,
});

describe("audience matchers — lastOpen", () => {
  const away = (days: number) => device({ lastOpenedAt: NOW - days * DAY });
  const rule = { __resolveType: "native/matchers/lastOpen.ts", minDays: 7 };

  it("fires for a device that has been away long enough", () => {
    expect(selectCampaigns([campaign({ audience: rule })], [away(10)], NOW)).toHaveLength(1);
  });

  it("does not fire for an active device", () => {
    expect(selectCampaigns([campaign({ audience: rule })], [away(2)], NOW)).toHaveLength(0);
  });

  it("supports a window, so a 30-day campaign does not also hit 200-day devices", () => {
    const windowed = { __resolveType: "native/matchers/lastOpen.ts", minDays: 7, maxDays: 30 };
    const devices = [away(10), away(60)];
    const hit = selectCampaigns([campaign({ audience: windowed })], devices, NOW);
    expect(hit).toHaveLength(1);
    expect(hit[0].device.lastOpenedAt).toBe(away(10).lastOpenedAt);
  });

  it("skips a device that never opened the app", () => {
    // No signal is not the same as "away for a long time".
    expect(selectCampaigns([campaign({ audience: rule })], [device()], NOW)).toHaveLength(0);
  });

  it("tolerates the string a JSON form produces", () => {
    const asString = { __resolveType: "native/matchers/lastOpen.ts", minDays: "7" };
    expect(selectCampaigns([campaign({ audience: asString })], [away(10)], NOW)).toHaveLength(1);
  });
});

describe("audience matchers — cartAge", () => {
  const rule = { __resolveType: "native/matchers/cartAge.ts", minHours: 4 };

  it("fires for a cart left untouched", () => {
    const abandoned = device({ cartUpdatedAt: NOW - 6 * HOUR, cartItemCount: 2 });
    expect(selectCampaigns([campaign({ audience: rule })], [abandoned], NOW)).toHaveLength(1);
  });

  it("does not fire for an empty cart, however old", () => {
    // The timestamp alone would match; an empty cart is not abandonment.
    const empty = device({ cartUpdatedAt: NOW - 50 * HOUR, cartItemCount: 0 });
    expect(selectCampaigns([campaign({ audience: rule })], [empty], NOW)).toHaveLength(0);
  });

  it("does not fire while the cart is still fresh", () => {
    const fresh = device({ cartUpdatedAt: NOW - 1 * HOUR, cartItemCount: 1 });
    expect(selectCampaigns([campaign({ audience: rule })], [fresh], NOW)).toHaveLength(0);
  });
});

describe("audience matchers — platform, signedIn, tag", () => {
  it("targets one platform", () => {
    const rule = { __resolveType: "native/matchers/platform.ts", ios: true };
    const devices = [device({ platform: "ios" }), device({ platform: "android" })];
    expect(selectCampaigns([campaign({ audience: rule })], devices, NOW)).toHaveLength(1);
  });

  it("matches every platform when no flag is set", () => {
    const rule = { __resolveType: "native/matchers/platform.ts" };
    const devices = [device({ platform: "ios" }), device({ platform: "android" })];
    expect(selectCampaigns([campaign({ audience: rule })], devices, NOW)).toHaveLength(2);
  });

  it("targets signed-out devices", () => {
    const rule = { __resolveType: "native/matchers/signedIn.ts", signedIn: false };
    const devices = [device({ signedIn: true }), device({ signedIn: false })];
    const hit = selectCampaigns([campaign({ audience: rule })], devices, NOW);
    expect(hit).toHaveLength(1);
    expect(hit[0].device.signedIn).toBe(false);
  });

  it("targets a tag", () => {
    const rule = { __resolveType: "native/matchers/tag.ts", tag: "vip" };
    const devices = [device({ tags: ["vip"] }), device({ tags: ["beta"] }), device()];
    expect(selectCampaigns([campaign({ audience: rule })], devices, NOW)).toHaveLength(1);
  });
});

describe("composition — the reason this reuses the CMS matchers", () => {
  it("combines conditions with multi/and", () => {
    const audience = {
      __resolveType: "website/matchers/multi.ts",
      op: "and",
      matchers: [
        { __resolveType: "native/matchers/cartAge.ts", minHours: 4 },
        { __resolveType: "native/matchers/platform.ts", ios: true },
      ],
    };
    const devices = [
      device({ platform: "ios", cartUpdatedAt: NOW - 6 * HOUR, cartItemCount: 1 }),
      device({ platform: "android", cartUpdatedAt: NOW - 6 * HOUR, cartItemCount: 1 }),
    ];
    expect(selectCampaigns([campaign({ audience })], devices, NOW)).toHaveLength(1);
  });

  it("negates a condition", () => {
    const audience = {
      __resolveType: "website/matchers/negate.ts",
      matcher: { __resolveType: "native/matchers/signedIn.ts", signedIn: true },
    };
    const devices = [device({ signedIn: true }), device({ signedIn: false })];
    expect(selectCampaigns([campaign({ audience })], devices, NOW)).toHaveLength(1);
  });

  it("resolves an audience saved as a reusable decofile block", () => {
    // The point of authoring in Studio: define "carrinho abandonado" once and
    // point several campaigns at it.
    setBlocks({
      "Carrinho abandonado": { __resolveType: "native/matchers/cartAge.ts", minHours: 4 },
    });
    const audience = { __resolveType: "Carrinho abandonado" };
    const abandoned = device({ cartUpdatedAt: NOW - 6 * HOUR, cartItemCount: 1 });
    expect(selectCampaigns([campaign({ audience })], [abandoned], NOW)).toHaveLength(1);
  });

  it("sends to everyone when no audience is set", () => {
    expect(selectCampaigns([campaign()], [device(), device()], NOW)).toHaveLength(2);
  });
});

describe("frequency capping", () => {
  const recent = device({ lastSentAt: { c1: NOW - 2 * HOUR } });

  it("holds a device inside the cooldown window", () => {
    // Without this a matching campaign notifies every sweep, which is how an
    // app gets uninstalled.
    expect(selectCampaigns([campaign({ cooldownHours: 24 })], [recent], NOW)).toHaveLength(0);
  });

  it("releases it once the window passes", () => {
    expect(selectCampaigns([campaign({ cooldownHours: 1 })], [recent], NOW)).toHaveLength(1);
  });

  it("caps per campaign, not per device", () => {
    const two = [campaign({ id: "c1" }), campaign({ id: "c2" })];
    const hit = selectCampaigns(two, [recent], NOW);
    expect(hit.map((h) => h.campaign.id)).toEqual(["c2"]);
  });

  it("is exposed on its own for a caller that batches", () => {
    expect(isCoolingDown(campaign(), recent, NOW)).toBe(true);
  });
});

describe("selectCampaigns — safety", () => {
  it("skips a disabled campaign", () => {
    expect(selectCampaigns([campaign({ enabled: false })], [device()], NOW)).toHaveLength(0);
  });

  it("skips a campaign with no cooldown rather than notifying every sweep", () => {
    expect(selectCampaigns([campaign({ cooldownHours: 0 })], [device()], NOW)).toHaveLength(0);
  });

  it("excludes the device, not the campaign, when a matcher throws", () => {
    // evaluateMatcher fails closed. A push is not worth an exception, and one
    // bad device must not stop the sweep.
    const audience = { __resolveType: "native/matchers/tag.ts" }; // no `tag`
    const devices = [device({ tags: ["vip"] }), device({ tags: ["vip"] })];
    expect(selectCampaigns([campaign({ audience })], devices, NOW)).toHaveLength(0);
  });

  it("pairs every campaign with the device it matched", () => {
    const rule = { __resolveType: "native/matchers/platform.ts", android: true };
    const devices = [
      device({ platform: "ios", token: "a" }),
      device({ platform: "android", token: "b" }),
    ];
    const hit = selectCampaigns([campaign({ audience: rule })], devices, NOW);
    expect(hit[0].device.token).toBe("b");
  });
});
