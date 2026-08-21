import { describe, expect, it } from "vitest";
import { generateCiFiles } from "./ci-yml";
import { generateMainPushGuardYml } from "./main-push-guard-yml";
import { generateParityYml } from "./parity-yml";
import { generatePlaywrightFiles } from "./playwright-yml";
import { generateReactDoctorYml } from "./react-doctor-yml";
import { generateSyncBlocksBotYml } from "./sync-blocks-bot-yml";

describe("generateCiFiles", () => {
  const files = generateCiFiles("22.15.0", "1.3.5");
  const ci = files[".github/workflows/ci.yml"];

  it("emits the workflow plus the no-suppressions gate + allowlist", () => {
    expect(Object.keys(files).sort()).toEqual([
      ".github/workflows/ci.yml",
      "tools/gates/no-suppressions.sh",
      "tools/gates/suppressions-allowlist.txt",
    ]);
  });

  it("pins node + bun and installs frozen", () => {
    expect(ci).toContain("name: CI");
    expect(ci).toContain('NODE_VERSION: "22.15.0"');
    expect(ci).toContain('BUN_VERSION: "1.3.5"');
    expect(ci).toContain("bun install --frozen-lockfile");
  });

  it("blocks on generate + build, keeps cleanliness gates advisory", () => {
    // generate + build have NO continue-on-error
    expect(ci).toMatch(
      /Generate artifacts[\s\S]*?run: bun run generate && bun run generate:routes/,
    );
    expect(ci).toMatch(/Build \(vite\)\n\s+run: bun run build\n/);
    // the four cleanliness gates are advisory
    for (const advisory of ["Typecheck", "Format check", "Knip", "no new suppression"]) {
      const stepIdx = ci.indexOf(advisory);
      expect(stepIdx, `${advisory} step missing`).toBeGreaterThan(-1);
      // a continue-on-error appears within the step block
      expect(ci.slice(stepIdx, stepIdx + 200)).toContain("continue-on-error: true");
    }
  });

  it("strips a bun@ prefix from the version", () => {
    const f = generateCiFiles("22.15.0", "bun@1.3.5");
    expect(f[".github/workflows/ci.yml"]).toContain('BUN_VERSION: "1.3.5"');
  });

  it("is de-projectized — no colombo migration-debt refs", () => {
    const blob = Object.values(files).join("\n");
    expect(blob).not.toMatch(/oficina/i);
    expect(blob).not.toMatch(/#7[89]|#81/); // issues #78/#79/#81
    expect(blob).not.toMatch(/AGENTS\.md/);
  });

  it("ships an empty allowlist (only comments)", () => {
    const allow = files["tools/gates/suppressions-allowlist.txt"];
    const entries = allow.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
    expect(entries).toEqual([]);
  });
});

describe("generateMainPushGuardYml", () => {
  const yml = generateMainPushGuardYml();
  it("guards main pushes via the commits/{sha}/pulls API", () => {
    expect(yml).toContain("name: main-push-guard");
    expect(yml).toMatch(/on:\s*\n\s*push:\s*\n\s*branches: \[main\]/);
    expect(yml).toContain("commits/${SHA}/pulls");
    expect(yml).toContain("exit 1");
  });
});

describe("generatePlaywrightFiles", () => {
  const files = generatePlaywrightFiles("1.3.5");

  it("emits the workflow, a self-contained config, and a smoke spec", () => {
    expect(Object.keys(files).sort()).toEqual([
      ".github/workflows/playwright.yml",
      "playwright.config.ts",
      "tests/e2e/smoke.spec.ts",
    ]);
  });

  it("installs chromium + webkit and pins bun", () => {
    const wf = files[".github/workflows/playwright.yml"];
    expect(wf).toContain('bun-version: "1.3.5"');
    expect(wf).toContain("playwright install --with-deps chromium webkit");
    expect(wf).toContain("bun run test:e2e");
  });

  it("config is self-contained (no support-helper imports) and targets tests/e2e", () => {
    const cfg = files["playwright.config.ts"];
    expect(cfg).toContain('testDir: "./tests/e2e"');
    expect(cfg).not.toContain("./tests/support");
    expect(cfg).toContain("webkit");
  });

  it("smoke needs no app boot or network (uses setContent)", () => {
    const spec = files["tests/e2e/smoke.spec.ts"];
    expect(spec).toContain("page.setContent");
    expect(spec).not.toContain("await page.goto"); // no real navigation (comment may mention page.goto)
  });
});

describe("generateReactDoctorYml", () => {
  const yml = generateReactDoctorYml();
  it("runs react-doctor advisory (no uncommented blocking)", () => {
    expect(yml).toContain("name: React Doctor");
    expect(yml).toContain("millionco/react-doctor@v2");
    expect(yml).toContain("fetch-depth: 0");
    expect(yml).not.toMatch(/^\s*blocking: error/m);
  });
});

describe("generateParityYml", () => {
  const yml = generateParityYml("loja-tanstack");
  it("runs parity journey advisory, gated on PARITY_PROD_URL", () => {
    expect(yml).toContain("name: Parity");
    expect(yml).toContain("continue-on-error: true"); // advisory, never blocks
    expect(yml).toContain("vars.PARITY_PROD_URL"); // prod = original storefront
    expect(yml).toContain("bunx @decocms/parity journey");
    expect(yml).toContain("--junit parity-results.xml");
    expect(yml).toContain("--github");
    expect(yml).toContain("Workers Builds: loja-tanstack"); // worker name interpolated
    expect(yml).toContain("secrets.ANTHROPIC_API_KEY"); // optional LLM key
  });
});

describe("generateSyncBlocksBotYml", () => {
  const yml = generateSyncBlocksBotYml("bun@1.3.5");

  it("pulls on a daily cron, gated on SYNC_BLOCKS_ORIGIN", () => {
    expect(yml).toContain("name: sync-blocks-bot");
    expect(yml).toContain('BUN_VERSION: "1.3.5"'); // bun@ prefix stripped
    expect(yml).toContain('- cron: "0 6 * * *"');
    expect(yml).toContain("vars.SYNC_BLOCKS_ORIGIN");
    expect(yml).toContain("scripts/sync-blocks-bot.ts");
    expect(yml).toContain("--fail-on-plaintext-secret");
  });

  it("only ever needs GITHUB_TOKEN — no cross-repo credential", () => {
    expect(yml).toContain("secrets.GITHUB_TOKEN");
    expect(yml).not.toMatch(/secrets\.(?!GITHUB_TOKEN)[A-Z_]+/);
    expect(yml).toContain("permissions:");
    expect(yml).toContain("concurrency:");
  });

  it("guards the diff to .deco/blocks and builds before opening the PR", () => {
    const guardIdx = yml.indexOf("Guard");
    const buildIdx = yml.indexOf("Validar (generate + build)");
    const prIdx = yml.indexOf("gh pr create");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(buildIdx);
    expect(buildIdx).toBeLessThan(prIdx);
    expect(yml).toContain("grep -v '^\\.deco/blocks/'");
    expect(yml).toContain("git add .deco/blocks");
  });

  it("is de-projectized — no real site/customer names", () => {
    expect(yml).not.toMatch(/oficina|miess|colombo/i);
  });

  it("runs the site's own installed CLI, or a pinned one when given", () => {
    expect(yml).toContain("bunx tsx node_modules/@decocms/blocks-cli/scripts/sync-blocks-bot.ts");
    const pinned = generateSyncBlocksBotYml("1.3.5", "7.51.0");
    // `npx --package=<pkg> <bin>`, never `bunx <pkg> <bin>` — the latter treats
    // the bin name as an argument and silently runs deco-migrate instead.
    expect(pinned).toContain("npx --yes --package=@decocms/blocks-cli@7.51.0 deco-sync-blocks-bot");
    expect(pinned).not.toMatch(/bunx\s+(-y\s+)?@decocms\/blocks-cli/);
    expect(pinned).not.toContain("node_modules/@decocms/blocks-cli");
  });

  it("cannot pass green having run the wrong tool", () => {
    // pipefail so `| tee` doesn't swallow the plaintext-secret exit 1, plus a
    // grep on the report that only this script emits.
    expect(yml).toContain("set -o pipefail");
    expect(yml).toContain("--json --github");
    expect(yml).toContain(`grep -q '"remoteBlocks"'`);
  });
});
