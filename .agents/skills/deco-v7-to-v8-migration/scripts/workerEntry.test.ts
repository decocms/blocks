// @vitest-environment node
/**
 * The worker entry the migration writes on TanStack Start: the README's
 * recipe (the example's worker entry) with what v7's `createDecoWorkerEntry`
 * call said. `bindings.test.ts` type-checks one written into a site.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RECIPE, v7WorkerEntryParts, workerEntryRecipe } from "./workerEntry";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("the worker-entry recipe", () => {
  it("is the example's worker entry byte for byte (copy it here after changing the example)", () => {
    const example = fs.readFileSync(
      path.join(REPO, "examples/tanstack-worker-smoke/src/worker-entry.ts"),
      "utf8",
    );
    expect(RECIPE).toBe(example);
  });

  it("with the example's name and nothing from v7, it is the recipe", () => {
    expect(workerEntryRecipe({ site: "tanstack-worker-smoke" })).toBe(RECIPE);
  });

  it("puts the site's name, segment, CSP, imports and declarations in", () => {
    const out = workerEntryRecipe({
      site: "acme",
      segment:
        '(request) => ({ device: "desktop", region: request.headers.get("cf-region") ?? "" })',
      csp: "CSP",
      imports: ['import { x } from "./x";'],
      declarations: ['const CSP = ["img-src *"];'],
    });
    expect(out).toContain('import { cms } from "./cms";\nimport { x } from "./x";\n');
    expect(out).toContain('const CSP = ["img-src *"];\n\ninterface Env {');
    expect(out).toContain(
      'const buildSegment: (request: Request) => SiteSegment = (request) => ({ device: "desktop", region: request.headers.get("cf-region") ?? "" });',
    );
    expect(out).toContain('  site: "acme",\n  dev: import.meta.env.DEV,\n');
    expect(out).toContain("  csp: { reportOnly: CSP },\n  pageCache,\n");
  });
});

describe("what a v7 entry carries", () => {
  const V7 = [
    'import handler, { createServerEntry } from "@tanstack/react-start/server-entry";',
    'import { createDecoWorkerEntry } from "@decocms/tanstack";',
    'import { detectDevice } from "@decocms/blocks/sdk/useDevice";',
    'import { getCookies } from "@decocms/apps-shopify/utils/cookies";',
    'import { unused } from "./unused";',
    "const serverEntry = createServerEntry({ fetch: handler.fetch });",
    'const DIRECTIVES = ["img-src *"];',
    "const CSP = [...DIRECTIVES];",
    "const other = 1;",
    "export default createDecoWorkerEntry(serverEntry, {",
    "  csp: CSP,",
    "  buildSegment(request) {",
    '    return { device: detectDevice(""), loggedIn: !!getCookies(request.headers).token };',
    "  },",
    "  purgeTokenEnv: false,",
    "  proxyHandler: async () => null,",
    "});",
  ].join("\n");

  it("the segment (a method becomes a function), the CSP, and only the imports and declarations they use", () => {
    const found = v7WorkerEntryParts(V7, "acme");
    expect(found?.parts.segment).toBe(
      'function (request) {\n    return { device: detectDevice(""), loggedIn: !!getCookies(request.headers).token };\n  }',
    );
    expect(found?.parts.csp).toBe("CSP");
    // The recipe imports its own detectDevice (v7's expressions): v7's import isn't carried.
    expect(found?.parts.imports).toEqual([
      'import { getCookies } from "@decocms/apps-shopify/utils/cookies";',
    ]);
    expect(found?.parts.declarations).toEqual([
      'const DIRECTIVES = ["img-src *"];',
      "const CSP = [...DIRECTIVES];",
    ]);
    expect(found?.leftOut).toEqual(["purgeTokenEnv", "proxyHandler"]);
  });

  it("an entry with no createDecoWorkerEntry call isn't v7's", () => {
    expect(v7WorkerEntryParts('export default { fetch: () => new Response("") };', "acme")).toBe(
      undefined,
    );
  });
});
