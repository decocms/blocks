/**
 * Smoke tests for the `deco-upgrade-6-to-7` CLI (#367) — drives the script
 * as a child process against a tmp site fixture, verifying:
 *  - dry-run prints what would change without touching disk
 *  - --write applies the import-specifier rewrites and package.json swap
 *  - second --write run is a no-op (idempotency)
 */
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "upgrade-6-to-7.ts");

function run(cwd: string, args: string[]): { stdout: string; code: number } {
  const r = cp.spawnSync("npx", ["tsx", SCRIPT, ...args], { cwd, encoding: "utf8" });
  return { stdout: r.stdout || "", code: r.status ?? 0 };
}

describe("deco-upgrade-6-to-7 CLI (#367)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-6-to-7-"));
    fs.mkdirSync(path.join(tmp, "src", "routes"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "src", "routes", "$.tsx"),
      `import { cmsRouteConfig } from "@decocms/start/routes";\n` +
        `import { DecoPageRenderer } from "@decocms/start/hooks";\n`,
    );
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify(
        { name: "fixture-site", dependencies: { "@decocms/start": "6.30.0", "@decocms/apps": "5.4.0" } },
        null,
        2,
      ),
    );
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("dry-run reports what would change without writing", () => {
    const { stdout, code } = run(tmp, []);
    expect(code).toBe(0);
    expect(stdout).toContain("would upgrade");
    expect(stdout).toContain("removing @decocms/start, @decocms/apps");

    // Nothing actually changed on disk
    const src = fs.readFileSync(path.join(tmp, "src", "routes", "$.tsx"), "utf-8");
    expect(src).toContain("@decocms/start/routes");
    const pkg = JSON.parse(fs.readFileSync(path.join(tmp, "package.json"), "utf-8"));
    expect(pkg.dependencies).toHaveProperty("@decocms/start");
  });

  it("--write rewrites specifiers and package.json dependencies", () => {
    const { code } = run(tmp, ["--write"]);
    expect(code).toBe(0);

    const src = fs.readFileSync(path.join(tmp, "src", "routes", "$.tsx"), "utf-8");
    expect(src).toContain('import { cmsRouteConfig } from "@decocms/tanstack";');
    expect(src).toContain('import { DecoPageRenderer } from "@decocms/tanstack";');
    expect(src).not.toContain("@decocms/start");

    const pkg = JSON.parse(fs.readFileSync(path.join(tmp, "package.json"), "utf-8"));
    expect(pkg.dependencies).not.toHaveProperty("@decocms/start");
    expect(pkg.dependencies).not.toHaveProperty("@decocms/apps");
    expect(pkg.dependencies).toHaveProperty("@decocms/tanstack");
    expect(pkg.dependencies).toHaveProperty("@decocms/blocks");
  });

  it("second --write run is idempotent (no-op)", () => {
    run(tmp, ["--write"]);
    const { stdout } = run(tmp, ["--write"]);
    expect(stdout).toContain("Upgraded 0 file(s).");
  });
});
