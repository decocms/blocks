// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createFixture, type Fixture, recorder } from "./__tests__/fixture";
import { packageVersion } from "./root";
import { parseFlags, runCli } from "./run";
import { installSkills, shippedSkillsDir } from "./skills";

let fixture: Fixture;
afterEach(() => fixture?.remove());

const here = path.dirname(fileURLToPath(import.meta.url));

/** A site plus what the package ships, under `shipped/`: two skills and a folder that isn't one. */
function site(): { fixture: Fixture; from: string } {
  const f = createFixture({
    "shipped/alpha/SKILL.md": "---\nname: alpha\n---\nv2\n",
    "shipped/alpha/references/a.md": "a v2",
    "shipped/beta/SKILL.md": "---\nname: beta\n---\n",
    "shipped/not-a-skill/notes.md": "no SKILL.md here",
    "shipped/README.md": "the index",
  });
  return { fixture: f, from: path.join(f.root, "shipped") };
}

describe("deco skills install", () => {
  it("resolves the package's skills/ folder next to dist/ and src/", () => {
    expect(shippedSkillsDir()).toBe(`${path.resolve(here, "../../../skills")}${path.sep}`);
  });

  it("copies each shipped skill into .claude/skills/<name>/ and prints what it installed", async () => {
    const s = site();
    fixture = s.fixture;
    const out = recorder();
    expect(
      await runCli(["skills", "install"], { cwd: fixture.root, reporter: out, skillsDir: s.from }),
    ).toBe(0);
    expect(fixture.read(".claude/skills/alpha/SKILL.md")).toContain("v2");
    expect(fixture.read(".claude/skills/alpha/references/a.md")).toBe("a v2");
    expect(fixture.exists(".claude/skills/beta/SKILL.md")).toBe(true);
    expect(fixture.exists(".claude/skills/not-a-skill")).toBe(false);
    expect(fixture.exists(".claude/skills/README.md")).toBe(false);
    expect(out.lines.map((l) => l.message)).toEqual([
      "installed .claude/skills/alpha/",
      "installed .claude/skills/beta/",
      `2 skill(s) from @decocms/blocks ${packageVersion()} in .claude/skills`,
    ]);
  });

  it("replaces the skills it ships and leaves every other skill alone", () => {
    const s = site();
    fixture = s.fixture;
    fixture.write(".claude/skills/alpha/SKILL.md", "v1");
    fixture.write(".claude/skills/alpha/references/old.md", "gone in v2");
    fixture.write(".claude/skills/team-own/SKILL.md", "the team's skill");
    const result = installSkills({ root: fixture.root, from: s.from });
    expect(result).toEqual({
      dir: path.join(fixture.root, ".claude/skills"),
      skills: ["alpha", "beta"],
    });
    expect(fixture.read(".claude/skills/alpha/SKILL.md")).toContain("v2");
    expect(fixture.exists(".claude/skills/alpha/references/old.md")).toBe(false);
    expect(fixture.read(".claude/skills/team-own/SKILL.md")).toBe("the team's skill");
  });

  it("installs into --dir, relative to the folder that contains .deco/", async () => {
    const s = site();
    fixture = s.fixture;
    fixture.write("apps/store/.deco/blocks/.keep", "");
    const out = recorder();
    const lines: string[] = [];
    const code = await runCli(
      ["skills", "install", "--root", "apps/store", "--dir=.agents/skills", "--json"],
      { cwd: fixture.root, reporter: out, skillsDir: s.from, stdout: (t) => lines.push(t) },
    );
    expect(code).toBe(0);
    expect(fixture.exists("apps/store/.agents/skills/alpha/SKILL.md")).toBe(true);
    expect(fixture.exists(".claude/skills")).toBe(false);
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      {
        ok: true,
        dir: path.join(fixture.root, "apps/store/.agents/skills"),
        version: packageVersion(),
        skills: ["alpha", "beta"],
      },
    ]);
  });

  it("walks up to the folder with .deco/ from a subfolder", async () => {
    const s = site();
    fixture = s.fixture;
    fs.mkdirSync(path.join(fixture.root, "src/components"), { recursive: true });
    const code = await runCli(["skills", "install"], {
      cwd: path.join(fixture.root, "src/components"),
      reporter: recorder(),
      skillsDir: s.from,
    });
    expect(code).toBe(0);
    expect(fixture.exists(".claude/skills/beta/SKILL.md")).toBe(true);
  });

  it("fails (exit 1) when the package has no skills, and when it can't write", async () => {
    fixture = createFixture();
    const empty = recorder();
    const missing = path.join(fixture.root, "nothing");
    expect(
      await runCli(["skills", "install"], {
        cwd: fixture.root,
        reporter: empty,
        skillsDir: missing,
      }),
    ).toBe(1);
    expect(empty.text()).toContain(`no skills in ${missing}`);

    fixture.write("shipped/alpha/SKILL.md", "x");
    fixture.write("taken", "a file, not a folder");
    const blocked = recorder();
    expect(
      await runCli(["skills", "install", "--dir", "taken"], {
        cwd: fixture.root,
        reporter: blocked,
        skillsDir: path.join(fixture.root, "shipped"),
      }),
    ).toBe(1);
    expect(blocked.text()).toContain(
      `can't install the skills into ${path.join(fixture.root, "taken")}`,
    );
  });

  it("needs .deco/ (exit 1), like the other local commands", async () => {
    const s = site();
    fixture = s.fixture;
    fs.rmSync(path.join(fixture.root, ".deco"), { recursive: true });
    const out = recorder();
    expect(
      await runCli(["skills", "install"], { cwd: fixture.root, reporter: out, skillsDir: s.from }),
    ).toBe(1);
    expect(out.text()).toBe(
      `no .deco/ found from ${fixture.root}; run inside your app or pass --root`,
    );
  });

  it.each([
    [[], /deco skills needs a subcommand/],
    [["list"], /unexpected argument "list"/],
  ])("rejects deco skills %j as a usage error (exit 64)", async (args, message) => {
    fixture = createFixture();
    const out = recorder();
    expect(await runCli(["skills", ...args], { cwd: fixture.root, reporter: out })).toBe(64);
    expect(out.text()).toMatch(message);
    expect(out.text()).toContain("deco skills install [--dir=<path>]");
  });

  it("parses its flags", () => {
    expect(parseFlags("skills", ["install", "--dir", ".agents/skills"])).toEqual({
      _: ["install"],
      dir: ".agents/skills",
    });
    expect(() => parseFlags("skills", ["install", "extra"])).toThrow(/unexpected argument "extra"/);
    expect(() => parseFlags("skills", ["install", "--dir"])).toThrow(/--dir needs a value/);
    expect(() => parseFlags("skills", ["install", "--force"])).toThrow(/unknown flag --force/);
  });
});
