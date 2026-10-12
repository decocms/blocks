// @vitest-environment node
/**
 * The CMS settings (built-in-blocks#cms-settings, api-reference#cms-settings,
 * releases-and-drafts#allow-previews-per-host): `cms.settings()`, its caps,
 * and the host check of `cms.draftPointer` / `cms.draftCookie`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOSTED_ANALYTICS_COLLECTOR } from "./builtins/data";
import { createCMS, instanceOf, resetForTests } from "./cms";
import { currentTelemetry } from "./telemetry";
import { docsBlocks, docsSnapshot, fakeStudio } from "./testFixtures";
import type { EffectiveSettings, Snapshot } from "./types";

const POINTER = "studio.decocms.com/api/acme/decofile/store/main/changes?token=abc@9f3c1a";
const DEFAULTS: EffectiveSettings = {
  preview: { hosts: ["*"] },
  telemetry: { enabled: true, metrics: true, errorSampleRate: 0.05, traceSampleRate: 0 },
  analytics: { collector: HOSTED_ANALYTICS_COLLECTOR, enabled: true },
};

beforeEach(() => resetForTests());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetForTests();
});

/** The docs' release with a `CMS` block. */
function withSettings(settings: Record<string, unknown> | undefined, revision = "rev-1"): Snapshot {
  const snapshot = docsSnapshot(revision);
  if (settings !== undefined) snapshot.blocks.CMS = { __resolveType: "cms-settings", ...settings };
  return snapshot;
}

const lazy = (value: unknown) => ({ __resolveType: "lazy", value });
const request = (url: string, cookie?: string) =>
  new Request(url, { headers: cookie ? { cookie } : {} });

describe("cms.settings(): defaults", () => {
  it("with no CMS block, every default; every host may preview", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: docsSnapshot() });
    expect(await cms.settings()).toEqual(DEFAULTS);
  });

  it("the settings are deep-frozen: one caller can't change them for every request", async () => {
    const cms = createCMS({
      blocks: docsBlocks(),
      content: withSettings({ preview: { hosts: ["staging.example.com"] } }),
    });
    const settings = await cms.settings();
    expect(Object.isFrozen(settings)).toBe(true);
    expect(Object.isFrozen(settings.preview)).toBe(true);
    expect(Object.isFrozen(settings.preview.hosts)).toBe(true);
    expect(Object.isFrozen(settings.telemetry)).toBe(true);
    expect(Object.isFrozen(settings.analytics)).toBe(true);
    expect(() => {
      (settings.analytics as { enabled: boolean }).enabled = false;
    }).toThrow(TypeError);
    expect((await cms.settings()).analytics.enabled).toBe(true);
    expect(
      Object.isFrozen(await createCMS({ blocks: {}, content: docsSnapshot("r9") }).settings()),
    ).toBe(true);
  });

  it("an empty CMS block is the defaults too", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: withSettings({}) });
    expect(await cms.settings()).toEqual(DEFAULTS);
  });

  it("each field left out gets its default; the others are kept", async () => {
    const cms = createCMS({
      blocks: docsBlocks(),
      content: withSettings({
        telemetry: { metrics: false },
        analytics: { collector: "https://stats.example.com/events" },
      }),
    });
    expect(await cms.settings()).toEqual({
      preview: { hosts: ["*"] },
      telemetry: { enabled: true, metrics: false, errorSampleRate: 0.05, traceSampleRate: 0 },
      analytics: { collector: "https://stats.example.com/events", enabled: true },
    });
  });

  it("a CMS block of another type is ignored: the defaults apply", async () => {
    const snapshot = docsSnapshot();
    snapshot.blocks.CMS = { __resolveType: "seo", title: "t", description: "d" };
    const cms = createCMS({ blocks: docsBlocks(), content: snapshot });
    expect(await cms.settings()).toEqual(DEFAULTS);
  });

  it("garbage in a section is ignored field by field", async () => {
    const cms = createCMS({
      blocks: docsBlocks(),
      content: withSettings({
        preview: { hosts: "staging.example.com" },
        telemetry: { enabled: "no", errorSampleRate: "high" },
        analytics: { collector: 42, enabled: null },
      }),
    });
    expect(await cms.settings()).toEqual(DEFAULTS);
  });

  it("never rejects, even when the content loader fails", async () => {
    const cms = createCMS({
      blocks: {},
      content: {
        load: async () => {
          throw new Error("down");
        },
      },
    });
    await cms
      .forRelease()
      .revision()
      .catch(() => {});
    expect(await cms.settings()).toEqual(DEFAULTS);
  });
});

describe("cms.settings(): caps from code", () => {
  it("telemetry rates are the lower of content's and telemetry.limits (defaults 0.1 and 0)", async () => {
    const content = withSettings({ telemetry: { errorSampleRate: 0.5, traceSampleRate: 0.5 } });
    const defaults = await createCMS({ blocks: {}, content }).settings();
    expect(defaults.telemetry).toMatchObject({ errorSampleRate: 0.1, traceSampleRate: 0 });
    resetForTests();
    const limited = await createCMS({
      blocks: {},
      content,
      telemetry: {
        endpoint: "https://otel.example",
        limits: { errorSampleRate: 1, traceSampleRate: 0.2 },
      },
    }).settings();
    expect(limited.telemetry).toMatchObject({ errorSampleRate: 0.5, traceSampleRate: 0.2 });
  });

  it("telemetry: false still caps with the default limits", async () => {
    const cms = createCMS({
      blocks: {},
      content: withSettings({ telemetry: { errorSampleRate: 1 } }),
      telemetry: false,
    });
    expect((await cms.settings()).telemetry.errorSampleRate).toBe(0.1);
  });

  it("without a preview field, code's list applies (in normal form)", async () => {
    const cms = createCMS({
      blocks: {},
      content: withSettings({ telemetry: {} }),
      preview: { hosts: ["*.Example.com", "localhost:3000"] },
    });
    expect((await cms.settings()).preview.hosts).toEqual(["*.example.com", "localhost:3000"]);
  });

  it("content keeps only its entries that fall within code's list", async () => {
    const cms = createCMS({
      blocks: {},
      content: withSettings({
        preview: {
          hosts: [
            "staging.example.com",
            "*.preview.example.com",
            "localhost:3000",
            "localhost",
            "store.attacker.com",
            "staging.example.com.attacker.com",
            "*",
            "*.com",
            "https://staging.example.com",
          ],
        },
      }),
      preview: { hosts: ["*.example.com", "localhost:3000"] },
    });
    expect((await cms.settings()).preview.hosts).toEqual([
      "staging.example.com",
      "*.preview.example.com",
      "localhost:3000",
    ]);
  });

  it("without a cap, content may allow any valid pattern; invalid entries are left out", async () => {
    const cms = createCMS({
      blocks: {},
      content: withSettings({ preview: { hosts: ["Staging.Example.com.", "a b", "*.com", "*"] } }),
    });
    expect((await cms.settings()).preview.hosts).toEqual(["staging.example.com", "*"]);
  });

  it("an empty list turns previews off", async () => {
    const cms = createCMS({ blocks: {}, content: withSettings({ preview: { hosts: [] } }) });
    expect((await cms.settings()).preview.hosts).toEqual([]);
    const pointer = encodeURIComponent(POINTER);
    expect(await cms.draftPointer(request(`https://localhost/?__draft=${pointer}`))).toBeNull();
    expect(await cms.draftCookie(request(`https://localhost/?__draft=${pointer}`))).toBeNull();
  });

  it("createCMS throws on a pattern code can't read, naming it", () => {
    for (const bad of ["https://x.example.com", "*.com", "a*.example.com", "x.example.com/"]) {
      expect(
        () => createCMS({ blocks: {}, content: docsSnapshot(), preview: { hosts: [bad] } }),
        bad,
      ).toThrow(new RegExp(JSON.stringify(bad).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")));
    }
    expect(() =>
      createCMS({
        blocks: {},
        content: docsSnapshot(),
        preview: { hosts: "a.example.com" as unknown as string[] },
      }),
    ).toThrow(TypeError);
  });
});

describe("cms.settings(): variants", () => {
  it("a section can vary on its own, picked on each call", async () => {
    let campaign = false;
    const cms = createCMS({
      blocks: { campaign: () => campaign },
      content: withSettings({
        telemetry: { metrics: false },
        analytics: {
          __resolveType: "multivariate",
          variants: [
            { rule: { __resolveType: "campaign" }, value: lazy({ enabled: true }) },
            { rule: { __resolveType: "always" }, value: lazy({ enabled: false }) },
          ],
        },
      }),
    });
    expect((await cms.settings()).analytics.enabled).toBe(false);
    campaign = true;
    expect((await cms.settings()).analytics.enabled).toBe(true);
    // The other sections are unaffected.
    expect((await cms.settings()).telemetry.metrics).toBe(false);
  });

  it("a single field can have variants", async () => {
    const cms = createCMS({
      blocks: {},
      content: withSettings({
        preview: {
          hosts: {
            __resolveType: "multivariate",
            variants: [
              { rule: { __resolveType: "never" }, value: lazy(["never.example.com"]) },
              { rule: { __resolveType: "always" }, value: lazy(["staging.example.com"]) },
            ],
          },
        },
      }),
    });
    expect((await cms.settings()).preview.hosts).toEqual(["staging.example.com"]);
  });

  it("the whole block can be a reference to a saved block's values", async () => {
    const snapshot = withSettings({ analytics: { __resolveType: "Collector" } });
    snapshot.blocks.Collector = {
      __resolveType: "multivariate",
      variants: [{ rule: { __resolveType: "always" }, value: lazy({ enabled: false }) }],
    };
    const cms = createCMS({ blocks: {}, content: snapshot });
    expect((await cms.settings()).analytics.enabled).toBe(false);
  });

  it("a section that fails to resolve gets its defaults, still capped; the others are kept", async () => {
    const cms = createCMS({
      blocks: {
        broken: () => {
          throw new Error("no");
        },
      },
      content: withSettings({
        preview: { hosts: ["staging.example.com"] },
        telemetry: { __resolveType: "broken" },
        analytics: { enabled: false },
      }),
      preview: { hosts: ["*.example.com"] },
    });
    expect(await cms.settings()).toEqual({
      preview: { hosts: ["staging.example.com"] },
      telemetry: DEFAULTS.telemetry,
      analytics: { collector: HOSTED_ANALYTICS_COLLECTOR, enabled: false },
    });
  });

  it("a preview section that fails gets code's list, never every host", async () => {
    const cms = createCMS({
      blocks: {
        broken: () => {
          throw new Error("no");
        },
      },
      content: withSettings({ preview: { __resolveType: "broken" } }),
      preview: { hosts: ["staging.example.com"] },
    });
    expect((await cms.settings()).preview.hosts).toEqual(["staging.example.com"]);
  });
});

describe("cms.settings(): always the release in memory", () => {
  it("a custom loader with nothing in memory yet gives the defaults, without a load", async () => {
    const load = vi.fn(async () => withSettings({ analytics: { enabled: false } }));
    const cms = createCMS({
      blocks: {},
      content: { load, update: async () => ({ updated: false }) },
    });
    expect(await cms.settings()).toEqual(DEFAULTS);
    expect(load).not.toHaveBeenCalled();
    await cms.forRelease().revision();
    expect((await cms.settings()).analytics.enabled).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("after a custom loader's update, the old release's settings hold until the next one loads", async () => {
    let current = withSettings({ preview: { hosts: ["staging.example.com"] } }, "rev-1");
    const cms = createCMS({
      blocks: docsBlocks(),
      content: { load: async () => current, update: async () => ({ updated: true }) },
    });
    const link = `?__draft=${encodeURIComponent(POINTER)}`;
    await cms.forRelease().revision();
    current = withSettings({ preview: { hosts: ["next.example.com"] } }, "rev-2");
    expect(await cms.update()).toEqual({ updated: true });
    // Not the defaults (every host) in between: still the old release's hosts.
    expect((await cms.settings()).preview.hosts).toEqual(["staging.example.com"]);
    expect(await cms.draftPointer(request(`https://www.example.com/${link}`))).toBeNull();
    expect(await cms.forRelease().revision()).toBe("rev-2");
    expect((await cms.settings()).preview.hosts).toEqual(["next.example.com"]);
  });

  it("a draft that changes CMS changes neither the settings, nor its own preview gating", async () => {
    const release = withSettings({
      preview: { hosts: ["staging.example.com"] },
      analytics: { enabled: true },
    });
    const studio = fakeStudio();
    vi.stubGlobal("fetch", vi.fn(studio.fetch));
    const pointer = studio.draft({
      set: {
        CMS: {
          __resolveType: "cms-settings",
          preview: { hosts: ["*"] },
          analytics: { enabled: false },
        },
      },
    });
    const cms = createCMS({ blocks: docsBlocks(), content: release });
    await cms.forRelease().revision();
    const [saved] = await cms
      .forDraft(pointer)
      .resolve<{ preview: unknown }>("CMS", { run: false });
    expect(saved?.preview).toEqual({ hosts: ["*"] }); // the draft has it…
    const settings = await cms.settings(); // …the settings don't
    expect(settings.preview.hosts).toEqual(["staging.example.com"]);
    expect(settings.analytics.enabled).toBe(true);
    const link = `?__draft=${encodeURIComponent(pointer)}`;
    expect(await cms.draftPointer(request(`https://store.example.com/${link}`))).toBeNull();
    expect(await cms.draftPointer(request(`https://staging.example.com/${link}`))).toBe(pointer);
  });

  it("a draft that changes CMS doesn't change telemetry", async () => {
    const studio = fakeStudio();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
        String(input).startsWith("https://delivery.decocms.com/")
          ? studio.fetch(input, init)
          : new Response(null),
      ),
    );
    vi.spyOn(Math, "random").mockReturnValue(0);
    const release = withSettings({ telemetry: { traceSampleRate: 0 } });
    const pointer = studio.draft({
      set: { CMS: { __resolveType: "cms-settings", telemetry: { traceSampleRate: 1 } } },
    });
    const cms = createCMS({
      blocks: docsBlocks(),
      content: release,
      telemetry: { endpoint: "https://otel.example", limits: { traceSampleRate: 1 } },
    });
    await cms.forRelease().revision();
    expect((await cms.forDraft(pointer).resolve("SummerSEO"))[1]).toBeNull();
    expect(currentTelemetry()?.sampleTrace()).toBe(false);
  });

  it("telemetry follows the release's section before the release's first client runs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null)),
    );
    vi.spyOn(Math, "random").mockReturnValue(0);
    const cms = createCMS({
      blocks: docsBlocks(),
      content: withSettings({ telemetry: { traceSampleRate: 1 } }),
      telemetry: { endpoint: "https://otel.example", limits: { traceSampleRate: 1 } },
    });
    expect(currentTelemetry()?.sampleTrace()).toBe(false); // the defaults, before any client
    await cms.forRelease().revision();
    expect(currentTelemetry()?.sampleTrace()).toBe(true);
  });

  it("a telemetry section with a date rule takes effect within a minute, outside any request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null)),
    );
    vi.spyOn(Math, "random").mockReturnValue(0);
    let now = Date.parse("2026-10-05T12:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const cms = createCMS({
      blocks: docsBlocks(),
      content: withSettings({
        telemetry: {
          traceSampleRate: {
            __resolveType: "multivariate",
            variants: [
              {
                rule: { __resolveType: "date", start: "2026-10-05T12:00:30Z" },
                value: lazy(1),
              },
              { rule: { __resolveType: "always" }, value: lazy(0) },
            ],
          },
        },
      }),
      telemetry: { endpoint: "https://otel.example", limits: { traceSampleRate: 1 } },
    });
    await cms.forRelease().revision();
    expect(currentTelemetry()?.sampleTrace()).toBe(false);
    now += 45_000;
    await cms.forRelease().revision(); // within the minute: not read again
    expect(currentTelemetry()?.sampleTrace()).toBe(false);
    now += 30_000;
    await cms.forRelease().revision(); // read again, without holding up the request
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(currentTelemetry()?.sampleTrace()).toBe(true);
  });

  it("a hot reload with a new CMS block takes effect", async () => {
    const root = "/tmp/settings-hot-reload/.deco";
    const first = { ...withSettings({ analytics: { enabled: true } }), root };
    const cms = createCMS({ blocks: {}, content: first });
    expect((await cms.settings()).analytics.enabled).toBe(true);
    const second = { ...withSettings({ analytics: { enabled: false } }), root };
    expect(instanceOf(createCMS({ blocks: {}, content: second }))).toBe(instanceOf(cms));
    expect((await cms.settings()).analytics.enabled).toBe(false);
  });
});

describe("cms.draftPointer and cms.draftCookie on a host outside the list", () => {
  const settings = withSettings({
    preview: { hosts: ["staging.example.com", "*.preview.example.com"] },
  });
  const pointer = encodeURIComponent(POINTER);
  const cookie = `__deco_draft=${pointer}`;

  it("ignore the parameter and the cookie: the request gets the release, never an error", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: settings });
    for (const url of [
      `https://store.example.com/?__draft=${pointer}`,
      `https://preview.example.com/?__draft=${pointer}`,
      `https://staging.example.com.attacker.com/?__draft=${pointer}`,
      `https://a.preview.example.com.attacker.com/?__draft=${pointer}`,
      `https://xstaging.example.com/?__draft=${pointer}`,
    ]) {
      expect(await cms.draftPointer(request(url)), url).toBeNull();
      expect(await cms.draftCookie(request(url)), url).toBeNull();
    }
    // A URL whose host can't be read is outside the list.
    const relative = { url: `/relative?__draft=${pointer}`, headers: new Headers() };
    expect(await cms.draftPointer(relative)).toBeNull();
    expect(await cms.draftCookie(relative)).toBeNull();
    expect(await cms.draftPointer(request("https://store.example.com/", cookie))).toBeNull();
    const client = cms.forRelease();
    expect((await client.resolve<{ title: string }>("SummerSEO"))[0]?.title).toBe("Sunny!");
  });

  it("allow it on a listed host, in any case, with a trailing dot or a port", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: settings });
    for (const url of [
      `https://staging.example.com/?__draft=${pointer}`,
      `https://STAGING.example.com./x?__draft=${pointer}`,
      `http://staging.example.com:8080/?__draft=${pointer}`,
      `https://pr-12.preview.example.com/?__draft=${pointer}`,
    ]) {
      expect(await cms.draftPointer(request(url)), url).toBe(POINTER);
      expect(await cms.draftCookie(request(url)), url).toMatch(/^__deco_draft=/);
    }
    expect(await cms.draftPointer(request("https://staging.example.com/", cookie))).toBe(POINTER);
  });

  it("?__draft=off still expires the cookie on any host", async () => {
    const cms = createCMS({ blocks: docsBlocks(), content: settings });
    expect(await cms.draftCookie(request("https://store.example.com/?__draft=off"))).toMatch(
      /Max-Age=0/,
    );
    expect(
      await cms.draftPointer(request("https://store.example.com/?__draft=off", cookie)),
    ).toBeNull();
  });

  it("a cap in code keeps content from widening the list", async () => {
    const cms = createCMS({
      blocks: docsBlocks(),
      content: withSettings({ preview: { hosts: ["*", "store.example.com"] } }),
      preview: { hosts: ["staging.example.com"] },
    });
    expect((await cms.settings()).preview.hosts).toEqual([]);
    expect(
      await cms.draftPointer(request(`https://store.example.com/?__draft=${pointer}`)),
    ).toBeNull();
    expect(
      await cms.draftPointer(request(`https://staging.example.com/?__draft=${pointer}`)),
    ).toBeNull();
  });

  it("a cap in code applies on its own when content has no preview field", async () => {
    const cms = createCMS({
      blocks: docsBlocks(),
      content: docsSnapshot(),
      preview: { hosts: ["localhost:3000"] },
    });
    expect(await cms.draftPointer(request(`http://localhost:3000/?__draft=${pointer}`))).toBe(
      POINTER,
    );
    expect(await cms.draftPointer(request(`http://localhost:3001/?__draft=${pointer}`))).toBeNull();
  });
});
