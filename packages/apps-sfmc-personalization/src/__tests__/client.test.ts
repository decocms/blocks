/**
 * The Marketing Cloud Personalization client (/next/upstream-clients): the
 * Event API through the instrumented fetch, errors without bodies.
 */
import { describe, expect, it, vi } from "vitest";
import { createSfmcPersonalizationClient, SfmcPersonalizationError } from "../index";

function fakeFetch(status: number, body: unknown) {
  return vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status }),
  );
}

const config = { baseUrl: "https://acme.us-1.evergage.com", dataset: "engage" };
const event = {
  source: { channel: "WebServer", url: "https://shop.example.com/" },
  interaction: { name: "Personalization Campaigns" },
  user: { anonymousId: "anon-1" },
  flags: { nonInteractive: true, doNotTrack: false },
  pageView: false,
};

describe("createSfmcPersonalizationClient", () => {
  it("sendEvent posts the event to the dataset and returns the campaigns", async () => {
    const campaigns = { campaignResponses: [{ campaignId: "c1", payload: { products: [] } }] };
    const fetch = fakeFetch(200, campaigns);
    const sfmc = createSfmcPersonalizationClient(config, { fetch });

    await expect(sfmc.sendEvent(event)).resolves.toEqual(campaigns);

    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://acme.us-1.evergage.com/api2/event/engage");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(event);
  });

  it("throws the operation and status, never the body", async () => {
    const fetch = fakeFetch(500, { error: "anon-1 not found" });
    const sfmc = createSfmcPersonalizationClient(config, { fetch });

    const error = await sfmc.sendEvent(event).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SfmcPersonalizationError);
    expect(error).toMatchObject({ operation: "sendEvent", status: 500 });
    expect((error as Error).message).not.toContain("anon-1");
  });
});
