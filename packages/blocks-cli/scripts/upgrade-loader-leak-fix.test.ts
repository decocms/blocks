import { describe, expect, it } from "vitest";
import {
  applyDepBumps,
  isAffectedSite,
  planDepBumps,
  type SitePkg,
} from "./upgrade-loader-leak-fix";

function pkg(over: Partial<SitePkg> = {}): SitePkg {
  return {
    dependencies: {
      "@decocms/blocks": "^7.20.2",
      "@decocms/tanstack": "^7.20.2",
      "@decocms/apps-vtex": "^7.20.2",
      react: "19.0.0",
      "@tanstack/react-start": "1.166.8",
    },
    devDependencies: {
      "@decocms/blocks-cli": "^7.20.2",
      typescript: "^5.9.0",
    },
    ...over,
  };
}

describe("isAffectedSite", () => {
  it("true when @decocms/tanstack is a dependency", () => {
    expect(isAffectedSite(pkg())).toBe(true);
  });
  it("false for a non-deco or non-tanstack site", () => {
    expect(isAffectedSite({ dependencies: { react: "19.0.0" } })).toBe(false);
    expect(isAffectedSite({ dependencies: { "@decocms/nextjs": "^7.20.2" } })).toBe(false);
  });
});

describe("planDepBumps", () => {
  it("bumps every @decocms/* dep across deps + devDeps, leaving others alone", () => {
    const bumps = planDepBumps(pkg(), "^7.21.0");
    const names = bumps.map((b) => b.name).sort();
    expect(names).toEqual([
      "@decocms/apps-vtex",
      "@decocms/blocks",
      "@decocms/blocks-cli",
      "@decocms/tanstack",
    ]);
    // non-@decocms deps are never touched
    expect(names).not.toContain("react");
    expect(names).not.toContain("@tanstack/react-start");
    expect(names).not.toContain("typescript");
    // devDeps are covered
    expect(bumps.find((b) => b.name === "@decocms/blocks-cli")?.field).toBe("devDependencies");
  });

  it("returns nothing when already at the target spec (idempotent)", () => {
    const bumped = applyDepBumps(pkg(), planDepBumps(pkg(), "^7.21.0"));
    expect(planDepBumps(bumped, "^7.21.0")).toHaveLength(0);
  });
});

describe("applyDepBumps", () => {
  it("rewrites only @decocms/* specs and does not mutate the input", () => {
    const original = pkg();
    const next = applyDepBumps(original, planDepBumps(original, "^7.21.0"));
    expect(next.dependencies!["@decocms/tanstack"]).toBe("^7.21.0");
    expect(next.dependencies!["@decocms/apps-vtex"]).toBe("^7.21.0");
    expect(next.devDependencies!["@decocms/blocks-cli"]).toBe("^7.21.0");
    // untouched
    expect(next.dependencies!.react).toBe("19.0.0");
    // input unchanged
    expect(original.dependencies!["@decocms/tanstack"]).toBe("^7.20.2");
  });
});
