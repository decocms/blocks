import { describe, expect, it } from "vitest";
import { cssSafe, htmlSafeJson, jsString } from "./htmlSafe";

// These sinks emit into <script>/<style> via dangerouslySetInnerHTML, where the
// HTML parser — not the JS/JSON grammar — decides where the element ends. The
// only defense is escaping the characters that can terminate the element or its
// string context. Bare JSON.stringify does NOT do this (it escapes JSON
// metacharacters, not `<`), which is the whole bug class.

const BREAKOUT = "</script><script>alert(document.domain)</script>";
const LS = String.fromCharCode(0x2028); // line separator — breaks inline scripts
const PS = String.fromCharCode(0x2029); // paragraph separator

describe("htmlSafeJson — JSON embedded in <script>", () => {
  it("neutralizes a </script> breakout inside a string value", () => {
    const out = htmlSafeJson({ name: BREAKOUT });
    // The literal tag terminator must never survive into the HTML stream.
    expect(out).not.toContain("</script>");
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
  });

  it("stays valid JSON that parses back to the original value", () => {
    const data = { name: BREAKOUT, n: 1, nested: { u: `a${LS}b` } };
    expect(JSON.parse(htmlSafeJson(data))).toEqual(data);
  });

  it("escapes the line/paragraph separators that break inline scripts", () => {
    const out = htmlSafeJson({ s: `a${LS}b${PS}c` });
    expect(out).not.toContain(LS);
    expect(out).not.toContain(PS);
  });
});

describe("jsString — value interpolated into a single-quoted JS string", () => {
  it("neutralizes a </script> breakout", () => {
    const emitted = `posthog.init('${jsString(BREAKOUT)}')`;
    expect(emitted).not.toContain("</script>");
    expect(emitted).not.toContain("<");
  });

  it("neutralizes a single-quote string-breakout", () => {
    const esc = jsString("');alert(1);('");
    // The security invariant: no single quote may appear UN-escaped, so the
    // payload can never close the surrounding '...' literal early.
    expect(esc).not.toMatch(/(^|[^\\])'/);
    expect(esc).toContain("\\'");
  });

  it("leaves a benign value readable", () => {
    expect(jsString("phc_abc123")).toBe("phc_abc123");
  });
});

describe("cssSafe — value interpolated into a <style> body", () => {
  it("prevents a </style> breakout", () => {
    const out = cssSafe("red}</style><script>alert(1)</script>");
    expect(out).not.toContain("</style>");
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
  });

  it("leaves a benign CSS value intact", () => {
    expect(cssSafe("#fff")).toBe("#fff");
  });
});
