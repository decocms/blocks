import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const trackers = (html: string) => (html.match(/id="onedollarstats-tracker"/g) ?? []).length;

async function load() {
  vi.resetModules();
  return import("./OneDollarStats");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("OneDollarStats framework mount", () => {
  it("stays off by default: the framework renders nothing, a site's own mount still works", async () => {
    const { default: OneDollarStats, FrameworkOneDollarStats, OneDollarStatsScope } = await load();
    const html = renderToStaticMarkup(
      <>
        <FrameworkOneDollarStats />
        <OneDollarStatsScope>
          <OneDollarStats />
        </OneDollarStatsScope>
      </>,
    );
    expect(trackers(html)).toBe(1);
  });

  it("with ONEDOLLAR_AUTOMOUNT=true renders one tracker even when the site also mounts it", async () => {
    vi.stubEnv("ONEDOLLAR_AUTOMOUNT", "true");
    const { default: OneDollarStats, FrameworkOneDollarStats, OneDollarStatsScope } = await load();
    const html = renderToStaticMarkup(
      <>
        <FrameworkOneDollarStats />
        <OneDollarStatsScope>
          <OneDollarStats />
        </OneDollarStatsScope>
      </>,
    );
    expect(trackers(html)).toBe(1);
  });

  it("with ONEDOLLAR_AUTOMOUNT=true mounts it for a site that never did", async () => {
    vi.stubEnv("ONEDOLLAR_AUTOMOUNT", "true");
    const { FrameworkOneDollarStats, OneDollarStatsScope } = await load();
    const html = renderToStaticMarkup(
      <>
        <FrameworkOneDollarStats />
        <OneDollarStatsScope>
          <p>page</p>
        </OneDollarStatsScope>
      </>,
    );
    expect(trackers(html)).toBe(1);
  });

  it("ONEDOLLAR_ENABLED=false wins over the automount", async () => {
    vi.stubEnv("ONEDOLLAR_AUTOMOUNT", "true");
    vi.stubEnv("ONEDOLLAR_ENABLED", "false");
    const { default: OneDollarStats, FrameworkOneDollarStats, OneDollarStatsScope } = await load();
    const html = renderToStaticMarkup(
      <>
        <FrameworkOneDollarStats />
        <OneDollarStatsScope>
          <OneDollarStats />
        </OneDollarStatsScope>
      </>,
    );
    expect(trackers(html)).toBe(0);
  });
});
