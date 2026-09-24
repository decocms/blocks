// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPlan, parseCliOptions } from "./generate";

const tsx = createRequire(import.meta.url).resolve("tsx/cli");
const script = fileURLToPath(new URL("./generate.ts", import.meta.url));

describe("generation in a workspace with hoisted dependencies", () => {
  let workspace: string;
  let site: string;

  function write(root: string, relative: string, content: string): string {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  }

  function install(root: string, name: string, version = "7.48.4"): string {
    const dir = path.join(root, "node_modules", name);
    // Published packages need not export their root or package.json.
    write(
      dir,
      "package.json",
      JSON.stringify({ name, version, exports: { "./mod": "./src/mod.ts" } }),
    );
    return dir;
  }

  function plans(args: string[] = []) {
    return Object.fromEntries(buildPlan(site, parseCliOptions(args)).map((p) => [p.name, p]));
  }

  function run(args: string[]) {
    // Exercise --root too: the caller's cwd is the workspace, not the site.
    const result = spawnSync(process.execPath, [tsx, script, "--root", "apps/website", ...args], {
      cwd: workspace,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return result.stdout;
  }

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "generate-workspaces-"));
    site = path.join(workspace, "apps", "website");
    write(workspace, "package.json", JSON.stringify({ private: true, workspaces: ["apps/*"] }));
    write(site, "package.json", JSON.stringify({ name: "website", type: "module" }));
    write(site, "tsconfig.json", JSON.stringify({ compilerOptions: { jsx: "react-jsx" } }));
    write(site, ".deco/blocks/Home.json", JSON.stringify({ name: "Home", path: "/" }));
    write(site, "src/sections/Hero.tsx", "export default function Hero() { return null; }\n");
    install(workspace, "@decocms/blocks");
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("detects hoisted Next.js and enables its manifest and section registry", () => {
    install(workspace, "@decocms/nextjs");
    const plan = plans();
    expect(plan.manifest.enabled).toBe(true);
    expect(plan.blocks.enabled).toBe(false);
    expect(plan.sections.args).toContain("--registry");
  });

  it.each([
    "nextjs",
    "tanstack",
  ])("uses the site's %s binding when siblings hoist both frameworks", (framework) => {
    write(
      site,
      "package.json",
      JSON.stringify({
        name: "website",
        dependencies: { [`@decocms/${framework}`]: "7.48.4" },
      }),
    );
    install(workspace, "@decocms/nextjs");
    install(workspace, "@decocms/tanstack");
    install(workspace, "@tanstack/react-start");
    const app = install(workspace, "@decocms/apps-vtex");
    write(app, "src/invoke.ts", "export const invoke = {} as const;\n");
    const plan = plans();
    expect(plan.manifest.enabled).toBe(framework === "nextjs");
    expect(plan.sections.args.includes("--registry")).toBe(framework === "nextjs");
    expect(plan.blocks.enabled).toBe(framework === "tanstack");
    expect(plan.invoke.enabled).toBe(framework === "tanstack");
  });

  it.each([
    false,
    true,
  ])("generates invoke from hoisted packages (explicit apps directory: %s)", (explicit) => {
    install(workspace, "@tanstack/react-start", "1.166.8");
    const app = install(workspace, "@decocms/apps-vtex");
    write(
      app,
      "src/invoke.ts",
      `
import { createInvokeFn } from "@decocms/tanstack/sdk/createInvoke";
import { getOrCreateCart } from "./actions/checkout";
import type { OrderForm } from "./types";
export const invoke = {
  vtex: { actions: {
    getOrCreateCart: createInvokeFn(
      (data: { orderFormId?: string }) => getOrCreateCart(data),
    ) as unknown as (ctx: { data: { orderFormId?: string } }) => Promise<OrderForm>,
  } },
} as const;
`,
    );
    expect(plans().invoke.enabled).toBe(true);
    run([
      "--only",
      "invoke",
      ...(explicit ? ["--apps-dir", "../../node_modules/@decocms/apps-vtex"] : []),
    ]);
    const output = fs.readFileSync(path.join(site, "src/server/invoke.gen.ts"), "utf8");
    expect(output).toContain("getOrCreateCart");
    expect(output).toContain("@decocms/apps-vtex/actions/checkout");
  });

  it("does not use a parent invoke contract when a local package shadows it", () => {
    install(workspace, "@tanstack/react-start");
    const hoisted = install(workspace, "@decocms/apps-vtex");
    write(hoisted, "src/invoke.ts", "export const invoke = {};\n");
    install(site, "@decocms/apps-vtex");
    expect(plans().invoke.enabled).toBe(false);
  });

  it("fingerprints hoisted app sources and respects local package precedence and --skip-apps", () => {
    const hoisted = install(workspace, "@decocms/apps-vtex");
    const parentSource = write(hoisted, "src/loaders/product.ts", "export default () => [];\n");
    const inputPaths = (args: string[] = []) =>
      plans(args)
        .schema.inputs()
        .map(([rel]) => path.resolve(site, rel));
    expect(inputPaths()).toContain(parentSource);
    expect(inputPaths(["--skip-apps"])).not.toContain(parentSource);

    const local = install(site, "@decocms/apps-vtex", "7.48.5");
    const localSource = write(local, "src/loaders/local.ts", "export default () => [];\n");
    expect(inputPaths()).toContain(localSource);
    expect(inputPaths()).not.toContain(parentSource);
  });

  it("invalidates cached generation when a hoisted package version changes", () => {
    run(["--only", "loaders"]);
    const digests = JSON.parse(
      fs.readFileSync(path.join(site, ".deco/generate.digests.json"), "utf8"),
    );
    expect(digests.generators.loaders.deco).toContain("@decocms/blocks@7.48.4");
    expect(run(["--only", "loaders", "--dry-run"])).toContain("loaders: skip — cached");

    install(workspace, "@decocms/blocks", "7.48.5");
    expect(run(["--only", "loaders", "--dry-run"])).toContain("loaders: would run");
  });

  it("fingerprints the nearest package version, ignoring a shadowed parent's updates", () => {
    install(site, "@decocms/blocks", "7.48.6");
    run(["--only", "loaders"]);
    const digests = JSON.parse(
      fs.readFileSync(path.join(site, ".deco/generate.digests.json"), "utf8"),
    );
    expect(digests.generators.loaders.deco).toContain("@decocms/blocks@7.48.6");
    expect(digests.generators.loaders.deco).not.toContain("@decocms/blocks@7.48.4");

    install(workspace, "@decocms/blocks", "7.48.7");
    expect(run(["--only", "loaders", "--dry-run"])).toContain("loaders: skip — cached");
  });
});
