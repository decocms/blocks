import { describe, expect, it } from "vitest";
import { transformTimerTypes } from "./timer-types";

describe("transformTimerTypes", () => {
  it("retypes a `number` handle assigned setTimeout", () => {
    const r = transformTimerTypes(`let hideTimeout: number;\nhideTimeout = setTimeout(() => {}, 100);`);
    expect(r.changed).toBe(true);
    expect(r.content).toContain("let hideTimeout: ReturnType<typeof setTimeout>");
  });

  it("retypes a setInterval handle", () => {
    const r = transformTimerTypes(`let poll: number;\npoll = setInterval(fn, 1000);`);
    expect(r.content).toContain("let poll: ReturnType<typeof setInterval>");
  });

  it("leaves an unrelated numeric variable alone", () => {
    const r = transformTimerTypes(`let count: number;\ncount = 5;\nlet t: number;\nt = setTimeout(f, 1);`);
    expect(r.content).toContain("let count: number");
    expect(r.content).toContain("let t: ReturnType<typeof setTimeout>");
  });

  it("handles the window.setTimeout form", () => {
    const r = transformTimerTypes(`let x: number;\nx = window.setTimeout(f, 1);`);
    expect(r.content).toContain("let x: ReturnType<typeof setTimeout>");
  });

  it("is a no-op when the handle is never assigned a timer", () => {
    expect(transformTimerTypes(`let y: number;`).changed).toBe(false);
  });
});
