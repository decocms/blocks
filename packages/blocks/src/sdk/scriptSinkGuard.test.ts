import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Class guard: no inline <script>/<style> sink may serialize a value with a bare
// `JSON.stringify(...)` — that does not escape `</script>` and reintroduces the
// XSS class. Use htmlSafeJson/jsString/cssSafe (@decocms/blocks/sdk/htmlSafe).
// This test fails the build if a new sink regresses, anywhere in packages/*.

const REPO_ROOT = process.cwd();
const PACKAGES = join(REPO_ROOT, "packages");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

// Match a `dangerouslySetInnerHTML` whose __html expression uses JSON.stringify,
// tolerating whitespace/newlines between the pieces.
const SINK_RE = /dangerouslySetInnerHTML\s*=\s*\{\{[\s\S]{0,200}?__html\s*:\s*[\s\S]{0,80}?JSON\.stringify/;

describe("no bare JSON.stringify in a <script>/<style> sink", () => {
  it("every dangerouslySetInnerHTML uses the htmlSafe helpers, not JSON.stringify", () => {
    const offenders: string[] = [];
    for (const file of walk(PACKAGES)) {
      const src = readFileSync(file, "utf8");
      if (SINK_RE.test(src)) offenders.push(file.slice(REPO_ROOT.length + 1));
    }
    expect(offenders).toEqual([]);
  });
});
