import { describe, expect, it } from "vitest";
import {
  detectSourceLayout,
  explainNonClassicLayout,
  type FsLike,
  type SourceLayout,
} from "./source-layout";

/**
 * In-memory FsLike for tests. Holds a Set of paths that "exist" — no
 * content needed since `detectSourceLayout` only calls `existsSync`.
 */
function makeFs(paths: string[]): FsLike {
  const set = new Set(paths.map((p) => p.replace(/\\/g, "/")));
  return {
    existsSync(p: string) {
      return set.has(p.replace(/\\/g, "/"));
    },
  };
}

/**
 * FsLike where each dir path is tagged as populated (has files) or empty.
 * `dirsWithFiles` exist AND report `hasFiles: true`; `emptyDirs` exist but
 * report `hasFiles: false` (leftover stubs).
 */
function makeFsWithFiles(dirsWithFiles: string[], emptyDirs: string[] = []): FsLike {
  const norm = (p: string) => p.replace(/\\/g, "/");
  const populated = new Set(dirsWithFiles.map(norm));
  const empty = new Set(emptyDirs.map(norm));
  return {
    existsSync(p) {
      const n = norm(p);
      return populated.has(n) || empty.has(n);
    },
    hasFiles(p) {
      return populated.has(norm(p));
    },
  };
}

const SITE = "/site";

describe("detectSourceLayout — classic layout", () => {
  it("classifies a site with sections/ at root as classic", () => {
    const fs = makeFs(["/site/sections"]);
    expect(detectSourceLayout(SITE, fs)).toBe("classic");
  });

  it("classifies multi-dir root layout as classic", () => {
    const fs = makeFs(["/site/sections", "/site/islands", "/site/components", "/site/loaders"]);
    expect(detectSourceLayout(SITE, fs)).toBe("classic");
  });

  it("any single recognised root dir is enough", () => {
    for (const d of ["sections", "islands", "components", "loaders", "actions"]) {
      const fs = makeFs([`/site/${d}`]);
      expect(detectSourceLayout(SITE, fs)).toBe("classic");
    }
  });
});

describe("detectSourceLayout — modern layout", () => {
  it("classifies src/sections-only as modern", () => {
    const fs = makeFs(["/site/src/sections"]);
    expect(detectSourceLayout(SITE, fs)).toBe("modern");
  });

  it("classifies multi-dir src/ layout as modern", () => {
    const fs = makeFs(["/site/src/sections", "/site/src/islands", "/site/src/components"]);
    expect(detectSourceLayout(SITE, fs)).toBe("modern");
  });
});

describe("detectSourceLayout — mixed layout", () => {
  it("flags both root + src/ as mixed", () => {
    const fs = makeFs(["/site/sections", "/site/src/sections"]);
    expect(detectSourceLayout(SITE, fs)).toBe("mixed");
  });

  it("flags partial overlap as mixed (root islands + src sections)", () => {
    const fs = makeFs(["/site/islands", "/site/src/sections"]);
    expect(detectSourceLayout(SITE, fs)).toBe("mixed");
  });
});

describe("detectSourceLayout — empty leftover dirs (hasFiles)", () => {
  it("ignores an EMPTY root sections/ next to a populated src/sections/ → modern", () => {
    // The real portal-davinci case: leftover empty `sections/` + real `src/sections/`.
    const fs = makeFsWithFiles(["/site/src/sections"], ["/site/sections"]);
    expect(detectSourceLayout(SITE, fs)).toBe("modern");
  });

  it("ignores an EMPTY src/sections/ next to a populated root sections/ → classic", () => {
    const fs = makeFsWithFiles(["/site/sections"], ["/site/src/sections"]);
    expect(detectSourceLayout(SITE, fs)).toBe("classic");
  });

  it("still flags genuinely mixed (both populated) as mixed", () => {
    const fs = makeFsWithFiles(["/site/sections", "/site/src/sections"]);
    expect(detectSourceLayout(SITE, fs)).toBe("mixed");
  });

  it("empty dirs on both sides → empty", () => {
    const fs = makeFsWithFiles([], ["/site/sections", "/site/src/sections"]);
    expect(detectSourceLayout(SITE, fs)).toBe("empty");
  });
});

describe("detectSourceLayout — empty layout", () => {
  it("returns empty when neither root nor src/ has recognised dirs", () => {
    const fs = makeFs(["/site/package.json", "/site/README.md"]);
    expect(detectSourceLayout(SITE, fs)).toBe("empty");
  });

  it("returns empty for an unrelated dir", () => {
    const fs = makeFs(["/site/random-dir/x.txt"]);
    expect(detectSourceLayout(SITE, fs)).toBe("empty");
  });
});

describe("detectSourceLayout — works against the real disk", () => {
  it("uses real fs by default", () => {
    // Just call with no fsAdapter on a real path that doesn't exist —
    // should return "empty" without throwing. Smoke check that the
    // default-arg wiring works.
    expect(detectSourceLayout("/this/does/not/exist")).toBe("empty");
  });
});

describe("explainNonClassicLayout — message content", () => {
  const cases: Array<[Exclude<SourceLayout, "classic">, string[]]> = [
    ["modern", ['Modern Fresh "src/" layout', "Move src/sections", "File an issue"]],
    ["mixed", ["Mixed layout", "pick one layout", "clean checkout"]],
    [
      "empty",
      [
        "No recognizable Deco layout",
        "sections, islands, components, loaders, actions",
        "--source",
      ],
    ],
  ];

  for (const [layout, fragments] of cases) {
    it(`${layout}: includes site path + key guidance`, () => {
      const msg = explainNonClassicLayout(layout, "/some/site");
      expect(msg).toContain("/some/site");
      for (const f of fragments) {
        expect(msg).toContain(f);
      }
    });
  }
});
