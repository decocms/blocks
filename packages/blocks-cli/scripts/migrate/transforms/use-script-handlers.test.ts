import { describe, expect, it } from "vitest";
import { transformUseScriptHandlers } from "./use-script-handlers";

describe("transformUseScriptHandlers", () => {
  it("rewrites an identifier callback + args to an arrow", () => {
    const r = transformUseScriptHandlers(`<button onClick={useScript(onClick, -1)} />`);
    expect(r.changed).toBe(true);
    expect(r.content).toContain(`onClick={() => onClick(-1)}`);
  });

  it("handles a no-arg identifier callback", () => {
    const r = transformUseScriptHandlers(`<button onClick={useScript(handleClick)} />`);
    expect(r.content).toContain(`onClick={() => handleClick()}`);
  });

  it("handles multiple args and any onEvent name", () => {
    const r = transformUseScriptHandlers(`<a onMouseEnter={useScript(prefetch, id, "x")} />`);
    expect(r.content).toContain(`onMouseEnter={() => prefetch(id, "x")}`);
  });

  it("leaves an INLINE arrow untouched (per-site closure → manual)", () => {
    const src = `<button onClick={useScript(({ x }) => { doThing(x); })} />`;
    const r = transformUseScriptHandlers(src);
    expect(r.changed).toBe(false);
    expect(r.content).toBe(src);
  });

  it("leaves an arg with nested parens untouched (safety)", () => {
    const src = `<button onClick={useScript(fn, foo(x))} />`;
    expect(transformUseScriptHandlers(src).changed).toBe(false);
  });

  it("does not touch a non-handler useScript call", () => {
    const src = `const s = useScript(fn, 1);`;
    expect(transformUseScriptHandlers(src).changed).toBe(false);
  });
});
