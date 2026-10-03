// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseFlags, runCli, USAGE } from "./run";
import { createFixture, type Fixture, recorder, STORE_FILES } from "./__tests__/fixture";

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
    expect(
      parseFlags("serve", [
        "--port=5000",
        "--allow-origin",
        "http://a",
        "--allow-origin=http://b",
        "--read-only",
      ]),
    ).toEqual({ port: "5000", "allow-origin": ["http://a", "http://b"], "read-only": true });
  });

  it.each([
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
    const out = recorder();
    const args = ["--root", "apps/store"];
    expect(await runCli(["schema", ...args], { cwd: fixture.root, reporter: out })).toBe(0);
    expect(await runCli(["content", ...args], { cwd: fixture.root, reporter: out })).toBe(0);
    expect(await runCli(["check", ...args], { cwd: fixture.root, reporter: out })).toBe(0);
    expect(fixture.exists("apps/store/.deco/schema.gen.json")).toBe(true);
    expect(fixture.exists("apps/store/.deco/blocks.gen.ts")).toBe(true);
    expect(out.lines.at(-1)?.message).toBe("1 saved block checked: 0 errors, 0 warnings");
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

  it("deco serve runs until stopped", async () => {
    fixture = createFixture();
    let stop!: () => void;
    const until = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const out = recorder();
    const done = runCli(["serve", "--port", "0", "--token", "t"], {
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
  it("runs under plain Node, through tsx", () => {
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
    expect(pkg.exports["./cli"]).toBe("./src/v8/cli/index.ts");
    expect(pkg.peerDependencies.typescript).toBeDefined();
  });
});

describe("nothing in app bundles", () => {
  it("the runtime never imports the CLI", () => {
    const src = path.join(packageRoot, "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (full !== here) walk(full);
        } else if (
          /\.(ts|tsx)$/.test(entry.name) &&
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
