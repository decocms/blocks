import { describe, expect, it } from "vitest";
import { extractVtexContext } from "../../middleware";
import { buildSegmentFromParams, parseSegment, serializeSegment } from "../segment";

const cookie = (json: string) => `vtex_segment=${btoa(json)}`;
const req = (path: string, cookieHeader?: string) =>
  new Request(`https://www.example.com${path}`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  });

describe("serializeSegment", () => {
  it("serializes a value above Latin-1 instead of throwing, and round-trips it", () => {
    const token = serializeSegment({ channel: "1", campaigns: "€ 😀" as never });
    expect(parseSegment(token)?.campaigns).toBe("€ 😀");
  });

  it("keeps an ASCII/Latin-1 segment byte-for-byte", () => {
    const seg = { channel: "1", utmi_campaign: "promoção", regionId: "v2.ABC" };
    expect(serializeSegment(seg)).toBe(
      btoa(
        JSON.stringify({
          campaigns: undefined,
          channel: "1",
          priceTables: undefined,
          regionId: "v2.ABC",
          utm_campaign: undefined,
          utm_source: undefined,
          utm_medium: undefined,
          utmi_campaign: "promoção",
        }),
      ),
    );
  });
});

describe("buildSegmentFromParams", () => {
  it("takes `sc` only as a VTEX integer id", () => {
    expect(buildSegmentFromParams(new URLSearchParams("sc=2")).channel).toBe("2");
    expect(buildSegmentFromParams(new URLSearchParams("sc=abc")).channel).toBeUndefined();
    expect(buildSegmentFromParams(new URLSearchParams("sc=%E2%82%AC")).channel).toBeUndefined();
  });
});

describe("extractVtexContext", () => {
  it("does not throw on `?sc=` outside Latin-1", () => {
    expect(extractVtexContext(req("/?sc=%E2%82%AC")).salesChannel).toBe("1");
  });

  it("does not throw on a vtex_segment carrying a \\u escape above Latin-1", () => {
    const ctx = extractVtexContext(req("/", cookie('{"channel":"1","campaigns":"\\u20ac"}')));
    expect(ctx.segment.campaigns).toBe("€");
    expect(parseSegment(ctx.segmentToken)?.campaigns).toBe("€");
  });
});
