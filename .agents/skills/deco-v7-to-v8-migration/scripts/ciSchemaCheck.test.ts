// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addSchemaCheck } from "./ciSchemaCheck";
import { createReport } from "./report";

let root: string | undefined;
afterEach(() => root && fs.rmSync(root, { recursive: true, force: true }));

function repo(files: Record<string, string>): string {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "deco-v7-ci-check-")));
  fs.mkdirSync(path.join(root, ".git"));
  for (const [file, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), data);
  }
  return root;
}

const read = (file: string) => fs.readFileSync(path.join(root as string, file), "utf8");

const CI = `name: CI
on:
  pull_request:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - name: Install
        run: bun install --frozen-lockfile
        # a comment kept with the step

      - run: bun run build
`;

describe("deco schema --check in the site's CI (PO 2026-10-15)", () => {
  it("goes right after the install step, before the build regenerates the schema", () => {
    repo({ "package.json": "{}", "bun.lock": "", ".github/workflows/ci.yml": CI });
    const report = createReport();
    addSchemaCheck(root as string, report);
    expect(read(".github/workflows/ci.yml")).toBe(
      CI.replace(
        "        # a comment kept with the step\n",
        "        # a comment kept with the step\n      - name: Check that .deco/schema.gen.json is up to date\n        run: bunx deco schema --check\n",
      ),
    );
    expect(report.done.find((n) => n.subject === "CI")?.message).toContain(
      ".github/workflows/ci.yml",
    );
    // A second run changes nothing.
    const again = createReport();
    addSchemaCheck(root as string, again);
    expect(read(".github/workflows/ci.yml").match(/schema --check/g)).toHaveLength(1);
    expect(again.done.find((n) => n.subject === "CI")?.message).toContain("already runs");
  });

  it("prefers the pull-request workflows, skips v7's content regeneration, and keeps the install's working directory", () => {
    const deploy = "on:\n  push:\njobs:\n  d:\n    steps:\n      - run: npm ci\n";
    const regen =
      "on:\n  pull_request:\njobs:\n  r:\n    steps:\n      - run: npm ci\n      - run: npm run generate:blocks\n";
    const pr =
      "on: [pull_request]\njobs:\n  t:\n    steps:\n      - run: npm ci\n        working-directory: apps/site\n      - run: npm test\n";
    repo({
      "apps/site/package.json": "{}",
      "package-lock.json": "{}",
      ".github/workflows/deploy.yml": deploy,
      ".github/workflows/regen-blocks.yml": regen,
      ".github/workflows/pr.yml": pr,
    });
    addSchemaCheck(path.join(root as string, "apps/site"), createReport());
    expect(read(".github/workflows/deploy.yml")).toBe(deploy);
    expect(read(".github/workflows/regen-blocks.yml")).toBe(regen);
    expect(read(".github/workflows/pr.yml")).toBe(
      pr.replace(
        "      - run: npm test\n",
        "      - name: Check that .deco/schema.gen.json is up to date\n        working-directory: apps/site\n        run: npx deco schema --check\n      - run: npm test\n",
      ),
    );
  });

  it("points at the site's folder in a monorepo with no working directory set", () => {
    const ci = "on: pull_request\njobs:\n  t:\n    steps:\n      - run: pnpm install\n";
    repo({ "site/package.json": "{}", "pnpm-lock.yaml": "", ".github/workflows/ci.yaml": ci });
    addSchemaCheck(path.join(root as string, "site"), createReport());
    expect(read(".github/workflows/ci.yaml")).toBe(
      `${ci}      - name: Check that .deco/schema.gen.json is up to date\n        working-directory: site\n        run: pnpm exec deco schema --check\n`,
    );
  });

  it("reports what it can't place", () => {
    repo({ "package.json": "{}" });
    let report = createReport();
    addSchemaCheck(root as string, report);
    expect(report.manual.find((n) => n.subject === "CI")?.message).toContain(
      "no CI workflow found",
    );
    fs.mkdirSync(path.join(root as string, ".github/workflows"), { recursive: true });
    const multiline =
      "on: pull_request\njobs:\n  t:\n    steps:\n      - run: |\n          npm ci\n";
    fs.writeFileSync(path.join(root as string, ".github/workflows/ci.yml"), multiline);
    report = createReport();
    addSchemaCheck(root as string, report);
    expect(read(".github/workflows/ci.yml")).toBe(multiline);
    expect(report.manual.find((n) => n.subject === "CI")?.message).toContain(
      "no one-line install step in .github/workflows/ci.yml",
    );
  });

  it("doesn't take a build or a global install for the install step", () => {
    const ci =
      "on: pull_request\njobs:\n  t:\n    steps:\n      - run: npm install -g pnpm\n      - run: bun run build\n      - run: yarn\n      - run: yarn build\n";
    repo({ "package.json": "{}", "yarn.lock": "", ".github/workflows/ci.yml": ci });
    addSchemaCheck(root as string, createReport());
    expect(read(".github/workflows/ci.yml")).toBe(
      ci.replace(
        "      - run: yarn build\n",
        "      - name: Check that .deco/schema.gen.json is up to date\n        run: yarn deco schema --check\n      - run: yarn build\n",
      ),
    );
  });
});
