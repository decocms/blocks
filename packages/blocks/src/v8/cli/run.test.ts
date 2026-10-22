// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { gitInit } from "../../protocol/__tests__/git";
import { createFixture, type Fixture, recorder, STORE_FILES } from "./__tests__/fixture";
import { parseFlags, runCli, USAGE } from "./run";

let fixture: Fixture;
afterEach(() => fixture?.remove());

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "../../..");
const hero = { __resolveType: "hero", title: "Summer", size: "md" };

describe("flags", () => {
  it("parses each command's flags, in both spellings", () => {
    expect(parseFlags("schema", ["--root", "apps/a", "--watch"])).toEqual({
      root: "apps/a",
      watch: true,
    });
    expect(parseFlags("serve", ["--port=5000", "--host", "0.0.0.0", "--read-only"])).toEqual({
      port: "5000",
      host: "0.0.0.0",
      "read-only": true,
    });
  });

  it("takes --color and --no-color on every command, the last one winning", () => {
    expect(parseFlags("check", ["--color"])).toEqual({ color: true });
    expect(parseFlags("schema", ["--no-color", "--watch"])).toEqual({ color: false, watch: true });
    expect(parseFlags("schema", ["--check"])).toEqual({ check: true });
    expect(parseFlags("serve", ["--no-color", "--color"])).toEqual({ color: true });
    expect(parseFlags("content", [])).toEqual({});
  });

  it.each([
    [["--color=always"], "check", /--color takes no value/],
    [["--no-color=1"], "schema", /--no-color takes no value/],
    [["--watch"], "check", /unknown flag --watch/],
    [["--root"], "check", /--root needs a value/],
    [["extra"], "content", /unexpected argument "extra"/],
    [["--watch=yes"], "content", /--watch takes no value/],
  ])("rejects %j for %s", (args, command, message) => {
    expect(() => parseFlags(command, args)).toThrow(message);
  });
});

describe("runCli", () => {
  it("prints the usage", async () => {
    const out = recorder();
    expect(await runCli(["--help"], { reporter: out })).toBe(0);
    expect(out.text()).toBe(USAGE);
    expect(await runCli([], { reporter: recorder() })).toBe(1);
  });

  it("rejects an unknown command and bad flags with exit 1", async () => {
    const out = recorder();
    expect(await runCli(["deploy"], { reporter: out })).toBe(1);
    expect(out.text()).toContain('unknown command "deploy"');
    expect(await runCli(["check", "--nope"], { reporter: recorder() })).toBe(1);
    const proto = recorder();
    expect(await runCli(["constructor"], { reporter: proto })).toBe(1);
    expect(proto.text()).toContain('unknown command "constructor"');
    expect(() => parseFlags("check", ["--toString", "x"])).toThrow(/unknown flag --toString/);
  });

  it("prints the walk-up error when there's no .deco/", async () => {
    fixture = createFixture();
    fs.rmSync(path.join(fixture.root, ".deco"), { recursive: true });
    const out = recorder();
    expect(await runCli(["content"], { cwd: fixture.root, reporter: out })).toBe(1);
    expect(out.text()).toBe(
      `no .deco/ found from ${fixture.root}; run inside your app or pass --root`,
    );
  });

  it("runs schema, content and check against --root from a monorepo root", async () => {
    fixture = createFixture();
    for (const [file, content] of Object.entries(STORE_FILES))
      fixture.write(`apps/store/${file}`, content);
    fixture.write("apps/store/src/deco.ts", fixture.read("src/deco.ts"));
    fixture.write("apps/store/.deco/blocks/Summer.json", hero);
    fixture.write("apps/store/.deco/blocks/CMS.json", { __resolveType: "cms-settings" });
    const out = recorder();
    const args = ["--root", "apps/store"];
    expect(await runCli(["schema", ...args], { cwd: fixture.root, reporter: out })).toBe(0);
    expect(await runCli(["content", ...args], { cwd: fixture.root, reporter: out })).toBe(0);
    expect(await runCli(["check", ...args], { cwd: fixture.root, reporter: out })).toBe(0);
    expect(fixture.exists("apps/store/.deco/schema.gen.json")).toBe(true);
    expect(fixture.exists("apps/store/.deco/blocks.gen.ts")).toBe(true);
    expect(out.lines.at(-1)?.message).toBe("2 saved blocks checked: 0 errors, 0 warnings");
  }, 60_000);

  it("deco content --watch regenerates when a file is added", async () => {
    fixture = createFixture({ ".deco/blocks/A.json": hero });
    let stop!: () => void;
    const until = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const out = recorder();
    const done = runCli(["content", "--watch"], { cwd: fixture.root, reporter: out, until });
    await waitFor(() => out.text().includes("watching for changes"));
    await settle();
    expect(fixture.read(".deco/blocks.gen.ts")).toContain('"A"');
    fixture.write(".deco/blocks/B.json", hero);
    await waitFor(() => fixture.read(".deco/blocks.gen.ts").includes('"B"'));
    stop();
    expect(await done).toBe(0);
  }, 20_000);

  it("deco schema --watch regenerates when a source file changes", async () => {
    fixture = createFixture({
      "src/a.tsx": "export const a = (props: { title: string }) => <p>{props.title}</p>;",
      ".deco/index.ts": 'import { a } from "../src/a"; export default { a };',
    });
    let stop!: () => void;
    const until = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const out = recorder();
    const done = runCli(["schema", "--watch"], { cwd: fixture.root, reporter: out, until });
    await waitFor(() => out.text().includes("watching for changes"), 30_000);
    await settle();
    expect(fixture.read(".deco/schema.gen.json")).toContain('"Title"');
    fixture.write(
      "src/a.tsx",
      "export const a = (props: { headline: string }) => <p>{props.headline}</p>;",
    );
    await waitFor(() => fixture.read(".deco/schema.gen.json").includes('"Headline"'), 30_000);
    stop();
    expect(await done).toBe(0);
  }, 60_000);

  it("deco schema --watch also regenerates when a monorepo package the block map imports changes", async () => {
    fixture = createFixture();
    fixture.write("apps/store/src/deco.ts", fixture.read("src/deco.ts"));
    fixture.write(
      "packages/ui/src/banner.tsx",
      "export const banner = (props: { title: string }) => <p>{props.title}</p>;",
    );
    fixture.write(
      "apps/store/.deco/index.ts",
      'import { banner } from "../../../packages/ui/src/banner"; export default { banner };',
    );
    let stop!: () => void;
    const until = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const out = recorder();
    const done = runCli(["schema", "--watch", "--root", "apps/store"], {
      cwd: fixture.root,
      reporter: out,
      until,
    });
    const schemaFile = "apps/store/.deco/schema.gen.json";
    await waitFor(() => out.text().includes("watching for changes"), 30_000);
    await settle();
    expect(fixture.read(schemaFile)).toContain('"Title"');
    fixture.write(
      "packages/ui/src/banner.tsx",
      "export const banner = (props: { headline: string }) => <p>{props.headline}</p>;",
    );
    await waitFor(() => fixture.read(schemaFile).includes('"Headline"'), 30_000);
    stop();
    expect(await done).toBe(0);
  }, 60_000);

  it("deco serve runs until stopped", async () => {
    fixture = createFixture();
    gitInit(fixture.root);
    let stop!: () => void;
    const until = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const out = recorder();
    const done = runCli(["serve", "--port", "0"], {
      cwd: fixture.root,
      reporter: out,
      until,
    });
    await waitFor(() => out.text().includes("Site editor"));
    stop();
    expect(await done).toBe(0);
  }, 20_000);
});

describe("the bin", () => {
  it("runs under plain Node, from the compiled dist/", () => {
    fixture = createFixture();
    fixture.write(".deco/blocks/A.json", hero);
    const result = spawnSync(process.execPath, [path.join(packageRoot, "bin/deco.js"), "content"], {
      cwd: fixture.root,
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/wrote \.deco\/blocks\.gen\.ts \(1 blocks/);
  }, 30_000);

  it("exits 1 when a command fails", () => {
    fixture = createFixture();
    const result = spawnSync(process.execPath, [path.join(packageRoot, "bin/deco.js"), "check"], {
      cwd: fixture.root,
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("run deco schema first");
  }, 30_000);

  it("is the package's single bin, and the commands are the ./cli subpath", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    expect(pkg.bin).toEqual({ deco: "./bin/deco.js" });
    expect(pkg.exports["./cli"]).toEqual({
      types: "./dist/v8/cli/index.d.ts",
      source: "./src/v8/cli/index.ts",
      default: "./dist/v8/cli/index.js",
    });
    expect(pkg.peerDependencies.typescript).toBeDefined();
    // The compiler is the app's peer, not one bundled into a dependency.
    expect(pkg.dependencies["ts-morph"]).toBeUndefined();
    // Tests and their fixtures stay out of the published package.
    expect(pkg.files).toEqual(
      expect.arrayContaining(["bin", "dist", "src", "!src/**/*.test.ts", "!src/**/__tests__"]),
    );
  });

  it("runs deco schema under plain Node with the typescript peer", () => {
    fixture = createFixture(STORE_FILES);
    const result = spawnSync(process.execPath, [path.join(packageRoot, "bin/deco.js"), "schema"], {
      cwd: fixture.root,
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/wrote \.deco\/schema\.gen\.json from index\.ts/);
  }, 60_000);
});

describe("deco schema --check", () => {
  const files = (props: string, extra = "") => ({
    "src/a.tsx": `export const a = (props: ${props}) => <p>{String(props)}</p>;\n${extra}`,
    ".deco/index.ts": `import * as m from "../src/a"; export default { ...m };`,
  });
  const check = async (args: string[] = []) => {
    const out = recorder();
    const code = await runCli(["schema", "--check", ...args], { cwd: fixture.root, reporter: out });
    return { code, out };
  };

  it("passes, writing nothing, when the file is what deco schema writes", async () => {
    fixture = createFixture(files("{ title: string }"));
    expect(await runCli(["schema"], { cwd: fixture.root, reporter: recorder() })).toBe(0);
    const file = path.join(fixture.root, ".deco/schema.gen.json");
    const before = fs.statSync(file).mtimeMs;
    const { code, out } = await check();
    expect(code).toBe(0);
    expect(out.text()).toBe(".deco/schema.gen.json is up to date with index.ts");
    expect(fs.statSync(file).mtimeMs).toBe(before);
  }, 60_000);

  it("fails, writing nothing, when the file is missing", async () => {
    fixture = createFixture(files("{ title: string }"));
    const { code, out } = await check();
    expect(code).toBe(1);
    expect(out.text()).toBe(
      ".deco/schema.gen.json is missing. Run `deco schema` and commit .deco/schema.gen.json.",
    );
    expect(fixture.exists(".deco/schema.gen.json")).toBe(false);
  }, 60_000);

  it("fails with what changed when the types moved on, and leaves the file as it was", async () => {
    fixture = createFixture(
      files("{ title: string }", "export const gone = (p: { x: string }) => <p>{p.x}</p>;"),
    );
    expect(await runCli(["schema"], { cwd: fixture.root, reporter: recorder() })).toBe(0);
    const saved = fixture.read(".deco/schema.gen.json");
    fixture.write(
      "src/a.tsx",
      [
        "export const a = (props: { headline: string }) => <p>{props.headline}</p>;",
        "export const b = (p: { y: string }) => <p>{p.y}</p>;",
      ].join("\n"),
    );
    const { code, out } = await check();
    expect(code).toBe(1);
    expect(out.lines.map((l) => l.level)).toEqual(["error"]);
    expect(out.text().split("\n")).toEqual([
      ".deco/schema.gen.json is out of date: the code's types have changed since it was written.",
      "  - sections: new in code: b",
      "  - sections: no longer in code: gone",
      "  - 2 schema definitions changed (fields or choices)",
      "Run `deco schema` and commit .deco/schema.gen.json.",
    ]);
    expect(fixture.read(".deco/schema.gen.json")).toBe(saved);
  }, 60_000);

  it("fails on a hand-edited file whose content is the same", async () => {
    fixture = createFixture(files("{ title: string }"));
    expect(await runCli(["schema"], { cwd: fixture.root, reporter: recorder() })).toBe(0);
    const json = JSON.parse(fixture.read(".deco/schema.gen.json"));
    fixture.write(".deco/schema.gen.json", JSON.stringify(json));
    const { code, out } = await check();
    expect(code).toBe(1);
    expect(out.text()).toContain("  - the content is the same but the formatting differs");
    fixture.write(".deco/schema.gen.json", "{ not json");
    expect((await check()).out.text()).toContain("  - the saved file is not valid JSON");
  }, 60_000);

  it("fails when the schema has errors, with the errors", async () => {
    fixture = createFixture({ ".deco/index.ts": "export default { a: 1 };" });
    const { code, out } = await check();
    expect(code).toBe(1);
    expect(out.text()).toContain(`"a" isn't a function`);
    expect(out.text()).toContain(".deco/schema.gen.json can't be checked: fix the errors above");
  }, 60_000);

  it("can't be combined with --watch", async () => {
    fixture = createFixture(files("{ title: string }"));
    const { code, out } = await check(["--watch"]);
    expect(code).toBe(1);
    expect(out.text()).toContain("--watch and --check can't be combined");
  });

  it("exits 1 under plain Node, for CI", () => {
    fixture = createFixture(STORE_FILES);
    const bin = path.join(packageRoot, "bin/deco.js");
    const run = (args: string[]) =>
      spawnSync(process.execPath, [bin, ...args], { cwd: fixture.root, encoding: "utf8" });
    const stale = run(["schema", "--check"]);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain(".deco/schema.gen.json is missing");
    expect(run(["schema"]).status).toBe(0);
    const fresh = run(["schema", "--check"]);
    expect(fresh.stderr).toBe("");
    expect(fresh.status).toBe(0);
  }, 60_000);
});

describe("nothing in app bundles", () => {
  it("the runtime never imports the CLI", () => {
    const src = path.join(packageRoot, "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (full !== here && entry.name !== "__conformance__") walk(full);
        } else if (
          /\.(ts|tsx)$/.test(entry.name) &&
          !/\.test\.tsx?$/.test(entry.name) &&
          /from\s+["'][^"']*v8\/cli[^"']*["']|@decocms\/blocks\/cli/.test(
            fs.readFileSync(full, "utf8"),
          )
        ) {
          offenders.push(path.relative(src, full));
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});

/** File watchers (FSEvents on macOS) start delivering events a moment after they're created. */
const settle = () => new Promise((r) => setTimeout(r, 300));

async function waitFor(condition: () => boolean, timeoutMs = 10_000) {
  const started = Date.now();
  for (;;) {
    try {
      if (condition()) return;
    } catch {
      // not there yet
    }
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}
