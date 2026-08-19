import { describe, expect, it } from "vitest";
import { transformPicture } from "./picture";

const CLASSIC = `<Picture preload className="grid-pos">
  <Source src={image.mobile} width={360} height={120} media="(max-width: 767px)" />
  <Source src={image.desktop} width={1440} height={200} media="(min-width: 767px)" />
  <img className="w-full" src={image.desktop} alt={image.alt ?? title} />
</Picture>`;

describe("transformPicture", () => {
  it("converts <Source>+<img> children into sources[] + top-level props", () => {
    const { content, changed, notes } = transformPicture(CLASSIC);
    expect(changed).toBe(true);
    expect(content).toContain("sources={[");
    // both sources, values unwrapped into an object literal
    expect(content).toContain(
      `{ src: image.mobile, width: 360, height: 120, media: "(max-width: 767px)" }`,
    );
    expect(content).toContain(`{ src: image.desktop, width: 1440, height: 200, media:`);
    // required-for-typecheck props lifted from the <img> fallback
    expect(content).toContain("src={image.desktop}");
    expect(content).toContain("width={1440}");
    expect(content).toContain("alt={image.alt ?? title}");
    // self-closing, children gone
    expect(content).not.toContain("<Source");
    expect(content).not.toContain("</Picture>");
    expect(notes.some((n) => n.includes("sources[]"))).toBe(true);
  });

  it("does not emit a duplicate className (Picture's own wins)", () => {
    const { content } = transformPicture(CLASSIC);
    expect((content.match(/className=/g) ?? []).length).toBe(1);
    expect(content).toContain(`className="grid-pos"`);
    expect(content).not.toContain(`"w-full"`);
  });

  it("lifts the <img> className when the Picture declares none", () => {
    const input = `<Picture preload><Source src={a} width={10} media="m" /><img className="w" src={a} alt={t} /></Picture>`;
    expect(transformPicture(input).content).toContain(`className="w"`);
  });

  it("leaves a prop-based Picture (no <Source> children) untouched", () => {
    const already = `<Picture sources={x} src={y} width={10} />`;
    const { content, changed } = transformPicture(already);
    expect(changed).toBe(false);
    expect(content).toBe(already);
  });

  it("handles a Picture with no <img> fallback (top props from last Source)", () => {
    const input = `<Picture><Source src={a} width={800} media="all" /></Picture>`;
    const { content } = transformPicture(input);
    expect(content).toContain("sources={[{ src: a, width: 800, media: \"all\" }]}");
    expect(content).toContain("src={a}");
    expect(content).toContain("width={800}");
  });
});
