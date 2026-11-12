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
    "http://admin.deco.cx",
    "null",
  ])("ignores a script sent by %s", (origin) => {
    expect(injectFrom(origin)).toBe(false);
  });
});
