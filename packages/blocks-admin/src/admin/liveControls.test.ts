import { describe, expect, it } from "vitest";
import { LIVE_CONTROLS_SCRIPT } from "./liveControls";

type MessageHandler = (event: { origin: string; data: unknown }) => void;

/** Runs the inline script on a fake page at `selfOrigin`; returns a sender. */
function bootOn(selfOrigin: string) {
  let onMessage: MessageHandler = () => {};
  const ran: number[] = [];
  new Function("window", "addEventListener", "ran", LIVE_CONTROLS_SCRIPT)(
    { location: { origin: selfOrigin } },
    (_type: string, fn: MessageHandler) => {
      onMessage = fn;
    },
    ran,
  );
  return (origin: string) => {
    ran.length = 0;
    onMessage({ origin, data: { type: "editor::inject", args: { script: "ran.push(1)" } } });
    return ran.length > 0;
  };
}

describe("LIVE_CONTROLS_SCRIPT editor::inject", () => {
  const injectFrom = bootOn("https://shop.example.com");

  it.each([
    "https://studio.decocms.com",
    "https://admin.deco.cx",
    "https://deco.cx",
    "https://shop.example.com",
  ])("runs a script sent by %s", (origin) => {
    expect(injectFrom(origin)).toBe(true);
  });

  it.each([
    "https://attacker--site.deco.host",
    "https://evil.example.com",
    "https://deco.cx.evil.example.com",
    "https://user-sandbox.preview-studio.decocms.com",
    "https://anything.deco.cx",
    "http://admin.deco.cx",
    "http://localhost:3000",
    "null",
  ])("ignores a script sent by %s", (origin) => {
    expect(injectFrom(origin)).toBe(false);
  });

  it("on a local dev page, trusts a locally run Studio or admin", () => {
    const injectLocal = bootOn("http://localhost:8000");
    expect(injectLocal("http://localhost:3000")).toBe(true);
    expect(injectLocal("http://127.0.0.1:4200")).toBe(true);
    expect(injectLocal("https://attacker--site.deco.host")).toBe(false);
  });
});
