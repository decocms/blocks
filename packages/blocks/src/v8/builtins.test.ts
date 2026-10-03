// @vitest-environment node
/** Built-in blocks (built-in-blocks.mdx) and matchers and variants (matchers-and-variants.mdx). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOSTED_ANALYTICS_COLLECTOR } from "./builtins/data";
import { builtIns, RESERVED_NAMES } from "./builtins/index";
import { date } from "./builtins/matchers";
import { multivariate } from "./builtins/multivariate";
import { createCMS, resetForTests } from "./cms";
import { docsBlocks, docsSnapshot } from "./testFixtures";
import type { Blocks, Page, Snapshot } from "./types";

beforeEach(() => resetForTests());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function client(blocks: Blocks = docsBlocks(), content: Snapshot = docsSnapshot()) {
  return createCMS({ blocks, content }).forRelease();
}

const lazyValue = (value: unknown) => ({ __resolveType: "lazy", value });

describe("the built-in list", () => {
  it("has the documented names (secret joins with the secrets module)", () => {
    expect(Object.keys(builtIns).sort()).toEqual(
      [
        "always",
        "analytics",
        "date",
        "lazy",
        "multivariate",
        "never",
        "page",
        "redirect",
        "telemetry",
      ].sort(),
    );
  });

  it("reserves every built-in name, secret included", () => {
    for (const name of [
      "page",
      "redirect",
      "telemetry",
      "analytics",
      "always",
      "never",
      "date",
      "multivariate",
      "lazy",
      "secret",
    ]) {
      expect(RESERVED_NAMES.has(name), name).toBe(true);
    }
  });
});

describe("always and never", () => {
  it("always returns true; never returns false", async () => {
    const c = client({});
    expect(await c.resolve({ __resolveType: "always" })).toEqual([true, null]);
    expect(await c.resolve({ __resolveType: "never" })).toEqual([false, null]);
  });
});

describe("date — start inclusive, end exclusive", () => {
  const start = "2026-11-27T00:00:00-05:00";
  const end = "2026-12-01T00:00:00-05:00";
  const cases: [string, string, boolean][] = [
    ["a minute before start", "2026-11-27T04:59:00Z", false],
    ["exactly at start", "2026-11-27T05:00:00Z", true],
    ["during the campaign", "2026-11-29T12:00:00Z", true],
    ["a millisecond before end", "2026-12-01T04:59:59.999Z", true],
    ["exactly at end", "2026-12-01T05:00:00Z", false],
    ["after end", "2026-12-02T00:00:00Z", false],
  ];
  for (const [label, now, expected] of cases) {
    it(`${label}: ${expected}`, () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(now));
      expect(date({ start, end })).toBe(expected);
    });
  }

  it("honours the offset: New York is -04:00 in summer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T03:59:59Z"));
    expect(date({ start: "2026-07-04T00:00:00-04:00" })).toBe(false);
    vi.setSystemTime(new Date("2026-07-04T04:00:00Z"));
    expect(date({ start: "2026-07-04T00:00:00-04:00" })).toBe(true);
  });

  it("a date without a time means midnight UTC", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T23:59:59Z"));
    expect(date({ start: "2026-11-27" })).toBe(false);
    vi.setSystemTime(new Date("2026-11-27T00:00:00Z"));
    expect(date({ start: "2026-11-27" })).toBe(true);
  });

  it("both bounds are optional", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    expect(date({})).toBe(true);
    expect(date()).toBe(true);
    expect(date({ start: "2026-01-01" })).toBe(true);
    expect(date({ end: "2027-01-01" })).toBe(true);
    expect(date({ end: "2026-01-01" })).toBe(false);
  });

  it("an unparseable bound never matches", () => {
    expect(date({ start: "not a date" })).toBe(false);
    expect(date({ end: "soon" })).toBe(false);
  });

  it("resolves as a block", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-28T00:00:00Z"));
    expect(await client({}).resolve({ __resolveType: "date", start, end })).toEqual([true, null]);
  });
});

describe("multivariate", () => {
  const blackFriday = {
    __resolveType: "promo-banner",
    title: {
      __resolveType: "multivariate",
      variants: [
        {
          rule: {
            __resolveType: "date",
            start: "2026-11-27T00:00:00-05:00",
            end: "2026-12-01T00:00:00-05:00",
          },
          value: lazyValue("Black Friday: 40% off everything"),
        },
        { rule: { __resolveType: "always" }, value: lazyValue("Free shipping over $50") },
      ],
    },
    href: "/deals",
  };

  it("schedules a campaign: the Black Friday title during the window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-28T12:00:00Z"));
    const [value] = await client().resolve(blackFriday);
    expect(value).toEqual({
      component: "promo-banner",
      props: { title: "Black Friday: 40% off everything", href: "/deals" },
    });
  });

  it("falls back to the always() variant outside it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-12-01T05:00:00Z"));
    const [value] = await client().resolve(blackFriday);
    expect(value).toEqual({
      component: "promo-banner",
      props: { title: "Free shipping over $50", href: "/deals" },
    });
  });

  it("only the winning variant runs; every rule runs", async () => {
    const heroA = vi.fn(() => "A");
    const heroB = vi.fn(() => "B");
    const ruleSpy = vi.fn(() => false);
    const [value] = await client({ heroA, heroB, ruleSpy }).resolve({
      __resolveType: "multivariate",
      variants: [
        { rule: { __resolveType: "always" }, value: lazyValue({ __resolveType: "heroA" }) },
        { rule: { __resolveType: "ruleSpy" }, value: lazyValue({ __resolveType: "heroB" }) },
      ],
    });
    expect(value).toBe("A");
    expect(heroA).toHaveBeenCalledTimes(1);
    expect(heroB).not.toHaveBeenCalled();
    expect(ruleSpy).toHaveBeenCalledTimes(1);
  });

  it("the first true rule wins", async () => {
    const [value] = await client({}).resolve({
      __resolveType: "multivariate",
      variants: [
        { rule: { __resolveType: "never" }, value: lazyValue("first") },
        { rule: { __resolveType: "always" }, value: lazyValue("second") },
        { rule: { __resolveType: "always" }, value: lazyValue("third") },
      ],
    });
    expect(value).toBe("second");
  });

  it("returns undefined when no rule is true", async () => {
    expect(
      await client({}).resolve({
        __resolveType: "multivariate",
        variants: [{ rule: { __resolveType: "never" }, value: lazyValue("x") }],
      }),
    ).toEqual([undefined, null]);
    await expect(multivariate({})).resolves.toBeUndefined();
    await expect(multivariate({ variants: [] })).resolves.toBeUndefined();
  });

  it("waits for an async matcher", async () => {
    const slowYes = async () => {
      await new Promise((r) => setTimeout(r, 1));
      return true;
    };
    const [value] = await client({ slowYes }).resolve({
      __resolveType: "multivariate",
      variants: [{ rule: { __resolveType: "slowYes" }, value: lazyValue("yes") }],
    });
    expect(value).toBe("yes");
  });

  it("accepts an experiment ID and still picks the first true rule", async () => {
    const split = vi.fn(({ percent }: { experiment: string; percent: number }) => percent >= 50);
    const [value] = await client({ split }).resolve({
      __resolveType: "multivariate",
      experiment: "hero-headline",
      variants: [
        {
          rule: { __resolveType: "split", experiment: "hero-headline", percent: 50 },
          value: lazyValue("Summer starts here"),
        },
        { rule: { __resolveType: "always" }, value: lazyValue("New summer collection") },
      ],
    });
    expect(value).toBe("Summer starts here");
    expect(split).toHaveBeenCalledWith({ experiment: "hero-headline", percent: 50 });
  });

  it("a user matcher (weekday) works in a rule", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-03T15:00:00Z")); // a Saturday in New York
    type Day = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";
    const weekday = ({
      days,
      timeZone = "America/New_York",
    }: {
      days: Day[];
      timeZone?: string;
    }) => {
      const today = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone }).format(
        new Date(),
      );
      return days.some((day) => day === today);
    };
    const [value] = await client({ weekday }).resolve({
      __resolveType: "multivariate",
      variants: [
        {
          rule: { __resolveType: "weekday", days: ["Sat", "Sun"] },
          value: lazyValue("Weekend: free shipping on everything"),
        },
        { rule: { __resolveType: "always" }, value: lazyValue("Free shipping over $50") },
      ],
    });
    expect(value).toBe("Weekend: free shipping on everything");
  });

  it("returns a value saved without the lazy wrapper rather than failing", async () => {
    await expect(
      multivariate({ variants: [{ rule: true, value: "plain" as never }] }),
    ).resolves.toBe("plain");
  });

  it("only a strictly true rule wins", async () => {
    await expect(
      multivariate({
        variants: [
          { rule: "yes" as unknown as boolean, value: async () => "truthy" },
          { rule: true, value: async () => "true" },
        ],
      }),
    ).resolves.toBe("true");
  });

  it("hides a block: never-only variants resolve to undefined, nothing inside runs, lists drop it", async () => {
    const hero = vi.fn(() => "hero");
    const [page] = await client({ ...docsBlocks(), hero }).resolve<Page>({
      __resolveType: "page",
      name: "Home",
      path: "/",
      sections: [
        { __resolveType: "promo-banner", title: "Free shipping", href: "/" },
        {
          __resolveType: "multivariate",
          variants: [
            { rule: { __resolveType: "never" }, value: lazyValue({ __resolveType: "hero" }) },
          ],
        },
      ],
    });
    expect(page?.sections).toEqual([
      { component: "promo-banner", props: { title: "Free shipping", href: "/" } },
    ]);
    expect(hero).not.toHaveBeenCalled();
  });

  it("varies a whole list of sections", async () => {
    const [page] = await client().resolve<Page>({
      __resolveType: "page",
      name: "Home",
      path: "/",
      sections: {
        __resolveType: "multivariate",
        variants: [
          {
            rule: { __resolveType: "always" },
            value: lazyValue([{ __resolveType: "hero", title: "A" }]),
          },
        ],
      },
    });
    expect(page?.sections).toEqual([{ component: "hero", props: { title: "A" } }]);
  });

  it("can be replaced by declaring multivariate in the block map", async () => {
    const mine = vi.fn(async ({ variants }: { variants: { value: () => Promise<unknown> }[] }) =>
      variants.at(-1)?.value(),
    );
    const [value] = await client({ multivariate: mine }).resolve({
      __resolveType: "multivariate",
      variants: [
        { rule: { __resolveType: "always" }, value: lazyValue("first") },
        { rule: { __resolveType: "never" }, value: lazyValue("last") },
      ],
    });
    expect(value).toBe("last");
  });
});

describe("page", () => {
  it("returns the page with seo and every block in sections resolved", async () => {
    const [page] = await client().resolve<Page>("HomePage");
    expect(page).toEqual({
      name: "Home",
      path: "/",
      sections: [
        {
          component: "product-card",
          props: {
            title: "Summer collection",
            product: { name: "Summer shirt", slug: "summer-shirt" },
          },
        },
      ],
    });
    expect(page?.seo).toBeUndefined();
  });

  it("change a built-in: page = (props: StorePage) => props adds a field, nothing lost", async () => {
    interface StorePage extends Page {
      theme: "light" | "dark";
    }
    const page = (props: StorePage) => props;
    const content = docsSnapshot();
    content.blocks.ThemedPage = { ...(content.blocks.SummerPage as object), theme: "dark" };
    const [resolved] = await client({ ...docsBlocks(), page }, content).resolve<StorePage>(
      "ThemedPage",
    );
    expect(resolved?.theme).toBe("dark");
    expect(resolved?.seo).toEqual({ title: "Sunny!", description: "Light layers for long days." });
    expect(resolved?.sections).toHaveLength(1);
  });
});

describe("redirect, telemetry, analytics", () => {
  it("redirect returns its arguments as saved, optional fields included", async () => {
    const saved = {
      from: "/old/:slug",
      to: "/new/:slug",
      permanent: false,
      status: 308,
      discardQueryParameters: true,
    };
    expect(await client({}).resolve({ __resolveType: "redirect", ...saved })).toEqual([
      saved,
      null,
    ]);
    expect(await client({}).resolve("LegacySummer")).toEqual([
      { from: "/campaigns/summer", to: "/summer", permanent: true },
      null,
    ]);
  });

  it("telemetry returns its arguments as saved", async () => {
    const settings = { enabled: false, metrics: true, errorSampleRate: 0.05, traceSampleRate: 0 };
    expect(await client({}).resolve({ __resolveType: "telemetry", ...settings })).toEqual([
      settings,
      null,
    ]);
    expect(await client({}).resolve({ __resolveType: "telemetry" })).toEqual([{}, null]);
  });

  it("analytics fills in the defaults: the hosted collector and enabled", async () => {
    expect(await client({}).resolve({ __resolveType: "analytics" })).toEqual([
      { collector: HOSTED_ANALYTICS_COLLECTOR, enabled: true },
      null,
    ]);
  });

  it("analytics keeps a collector and enabled: false", async () => {
    expect(
      await client({}).resolve({
        __resolveType: "analytics",
        collector: "https://stats.example.com/events",
        enabled: false,
      }),
    ).toEqual([{ collector: "https://stats.example.com/events", enabled: false }, null]);
  });

  it("the hosted collector is an https URL", () => {
    expect(new URL(HOSTED_ANALYTICS_COLLECTOR).protocol).toBe("https:");
  });
});
