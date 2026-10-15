import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import * as v7 from "./__fixtures__/v7/sdk/useScript";
import { pick, rng } from "./__tests__/v7";
import { inlineScript, useScript, useScriptAsDataURI } from "./script";

type Fn = (...args: any[]) => void;
const evaluate = (source: string): Fn => new Function(`return (${source});`)();

// Hand-written shapes: comments, strings and regexes that a careless
// minifier would break, every function syntax, and odd whitespace.
const SHAPES: string[] = [
  "function onLoad(id) { document.getElementById(id).dataset.ready = 'true'; }",
  "(id, n) => {\n  /* block\n comment */\n  const s = 'a  //  b';\n  return s + id + n;\n}",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: JavaScript source with a template literal
  "async function x() {\n\t// line comment stays\n\tawait Promise.resolve(`x  ${1}  y`);\n}",
  "() => /a\\s+b\\/\\*c\\*\\//g.test('a   b')",
  "function () { return '/* not a comment */'; }",
  "(a = { b: [1, 2] }) => { const c = a?.b ?? []; return c.length > 1 && c[0] < 2; }",
  "function*gen(){yield 1}",
  "class A { m() { return 1 } }",
  "\n\n  () =>   {    }   \n",
  "function (s) { return s.replace(/\\s\\s+/g, ' ') }",
];

const STATEMENTS = [
  "const a = 1;",
  'let s = "x  y";',
  "/* c */",
  "/** doc\n * more */",
  "// tail\n",
  "if (a > 0) { s += '//'; }",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: JavaScript source with a template literal
  "const t = `t  ${a}\n  u`;",
  "const r = /\\/\\*x\\*\\//;",
  "window.__x = { k: [1, 'two'] };",
  "for (let i = 0; i < 2; i++) { a; }",
  "return;",
];
const SPACE = [" ", "  ", "\n", "\n    ", "\t", "\r\n", ""];

function randomFunction(r: () => number, i: number): string {
  const body = Array.from({ length: Math.floor(r() * 7) }, () => pick(r, STATEMENTS))
    // Each in its own block, so repeated declarations stay valid (never run).
    .map((s) => `${pick(r, SPACE)}{${pick(r, SPACE)}${s}${pick(r, SPACE)}}`)
    .join(pick(r, SPACE.filter(Boolean)));
  const params = pick(r, ["", "a1", "a1, b2", "{ k }", "...rest"]);
  // `i` keeps every source distinct, so the run also exercises the LRU eviction.
  return pick(r, [
    `function f${i}(${params}) {${body}\n}`,
    `(${params}) => {${body} void ${i};}`,
    `async function (${params}) {${body} /* ${i} */}`,
  ]);
}

const VALUES: unknown[] = [
  0,
  -1.5,
  1e21,
  true,
  false,
  null,
  undefined,
  "",
  'a"b',
  "</script><script>x()</script>",
  "line\nbreak",
  "é 中 😀",
  "  ",
  [],
  [1, "2", null],
  { a: 1, b: { c: [true] } },
  { "": "", "a b": undefined },
];

describe("the script helpers are v7's", () => {
  let warn: MockInstance;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("useScript and useScriptAsDataURI give v7's bytes for every function shape", () => {
    for (const source of SHAPES) {
      const fn = evaluate(source);
      for (const args of [[], ["el-1"], [1, { a: [2] }], ["</script>", null]]) {
        expect(useScript(fn, ...args)).toBe(v7.useScript(fn, ...args));
        expect(useScriptAsDataURI(fn, ...args)).toBe(v7.useScriptAsDataURI(fn, ...args));
      }
    }
    expect(useScript(evaluate(SHAPES[1]), "x", 2)).toBe(
      "((id, n) => { const s = 'a // b'; return s + id + n; })(\"x\",2)",
    );
  });

  it("agrees with v7 on 5,000 generated functions and argument lists (and through LRU evictions)", () => {
    const r = rng(0x5c41);
    const made: Fn[] = [];
    for (let i = 0; i < 5_000; i++) {
      const fn = r() < 0.2 && made.length ? pick(r, made) : evaluate(randomFunction(r, i));
      made.push(fn);
      const args = Array.from({ length: Math.floor(r() * 4) }, () => pick(r, VALUES));
      const ours = useScript(fn, ...args);
      if (ours !== v7.useScript(fn, ...args)) {
        expect([fn.toString(), args, ours]).toEqual([
          fn.toString(),
          args,
          v7.useScript(fn, ...args),
        ]);
      }
      if (i % 10 === 0)
        expect(useScriptAsDataURI(fn, ...args)).toBe(v7.useScriptAsDataURI(fn, ...args));
    }
  });

  it("inlineScript returns v7's props", () => {
    expect(inlineScript("a()")).toEqual(v7.inlineScript("a()"));
    expect(inlineScript("a()")).toEqual({ dangerouslySetInnerHTML: { __html: "a()" } });
  });

  it("logs nothing: v7's warning read the environment, which a package doesn't", () => {
    useScript(function noWarning() {});
    expect(warn).not.toHaveBeenCalled();
    v7.useScript(function noWarning() {});
    expect(warn).toHaveBeenCalledTimes(1); // the reference still warns, as v7 did
  });
});
