import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectHandlers, renderModule } from "./generate-invoke-native";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Builds a site-shaped tree: src/loaders, src/actions, and an out dir. */
function site(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deco-invoke-native-"));
  dirs.push(root);
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  fs.mkdirSync(path.join(root, ".deco"), { recursive: true });
  return {
    root,
    collect: () =>
      collectHandlers({
        loadersDir: path.join(root, "src/loaders"),
        actionsDir: path.join(root, "src/actions"),
        outDir: path.join(root, ".deco"),
      }),
  };
}

describe("collectHandlers — keys", () => {
  it("derives invoke keys from the file path", () => {
    const { collect } = site({
      "src/actions/newsletter/subscribe.ts":
        "export default async function a(p: { email: string }): Promise<void> {}",
      "src/loaders/user.ts": "export default async function l(): Promise<void> {}",
    });
    expect(
      collect()
        .entries.map((e) => e.key)
        .sort(),
    ).toEqual(["site/actions/newsletter/subscribe", "site/loaders/user"]);
  });

  it("ignores `_`-prefixed helper modules", () => {
    // Same convention generate-loaders uses — those are not handlers.
    const { collect } = site({
      "src/loaders/_cookie.ts": "export const read = () => null;",
      "src/loaders/user.ts": "export default async function l(): Promise<void> {}",
    });
    expect(collect().entries.map((e) => e.key)).toEqual(["site/loaders/user"]);
  });
});

describe("collectHandlers — types", () => {
  it("reads the input type and unwraps Promise from the output", () => {
    const { collect } = site({
      "src/actions/x.ts": `
        export interface In { a: string }
        export interface Out { b: number }
        export default async function action(props: In): Promise<Out> { return { b: 1 }; }
      `,
    });
    const [entry] = collect().entries;
    expect(entry.input).toBe("In");
    expect(entry.output).toBe("Out");
  });

  it("imports a type from where it is ACTUALLY declared, not the handler file", () => {
    // The bug this exists for: assuming the handler exports every type it
    // mentions emits `import type { Person } from "../src/loaders/user"` and
    // TS2614s. Person really lives in a package.
    const { collect } = site({
      "src/loaders/user.ts": `
        import type { Person } from "@decocms/apps-commerce/types";
        export default async function l(): Promise<Person | null> { return null; }
      `,
    });
    expect(collect().entries[0].imports).toEqual([
      { name: "Person", source: "@decocms/apps-commerce/types" },
    ]);
  });

  it("rewrites a relative origin to be relative to the output file", () => {
    const { collect } = site({
      "src/platform/types.ts": "export interface State { ok: boolean }",
      "src/loaders/wishlist.ts": `
        import type { State } from "../platform/types";
        export default async function l(): Promise<State> { return { ok: true }; }
      `,
    });
    expect(collect().entries[0].imports[0].source).toBe("../src/platform/types");
  });

  it("degrades a local non-exported type to unknown, and says so", () => {
    // It cannot be named from outside its file at all — emitting an import
    // for it would not compile.
    const { collect } = site({
      "src/actions/y.ts": `
        interface Props { a: string }
        export default async function action(props: Props): Promise<void> {}
      `,
    });
    const { entries, skipped } = collect();
    expect(entries[0].input).toBe("unknown");
    expect(skipped.join()).toContain("degraded to unknown");
  });

  it("falls back to unknown when the handler has no type annotations", () => {
    const { collect } = site({ "src/actions/z.ts": "export default async function a(p) {}" });
    expect(collect().entries[0]).toMatchObject({ input: "unknown", output: "unknown" });
  });

  it("refuses to type a privileged action even if the site defines one", () => {
    // Mirrors generate-invoke's deny-list: these take a caller-supplied
    // `entity` against admin-credentialed MasterData.
    const { collect } = site({
      "src/actions/searchDocuments.ts":
        "export default async function a(p: { entity: string }): Promise<unknown> { return null; }",
    });
    const { entries, skipped } = collect();
    expect(entries).toHaveLength(0);
    expect(skipped.join()).toContain("privileged action");
  });
});

describe("renderModule", () => {
  it("aliases a name declared by two different modules", () => {
    // Without this, two `Props` produce a duplicate identifier.
    const entries = [
      {
        key: "site/actions/a/one",
        input: "Props",
        output: "void",
        imports: [{ name: "Props", source: "../src/actions/a/one" }],
      },
      {
        key: "site/actions/b/two",
        input: "Props",
        output: "void",
        imports: [{ name: "Props", source: "../src/actions/b/two" }],
      },
    ];
    const source = renderModule(entries);
    expect(source).toContain("Props as Props_a_one");
    expect(source).toContain("Props as Props_b_two");
    expect(source).toContain("props: Props_a_one");
  });

  it("does not alias the same name coming from one module", () => {
    const entries = [
      {
        key: "site/loaders/one",
        input: "unknown",
        output: "State",
        imports: [{ name: "State", source: "../src/types" }],
      },
      {
        key: "site/loaders/two",
        input: "unknown",
        output: "State",
        imports: [{ name: "State", source: "../src/types" }],
      },
    ];
    const source = renderModule(entries);
    expect(source).not.toContain(" as State_");
    expect(source.match(/from "\.\.\/src\/types"/g)).toHaveLength(1);
  });

  it("emits types only — nothing that could reach a bundle", () => {
    // The opt-in property: a site that upgrades and never imports this file is
    // completely unaffected. Every import must be `import type`, which TS
    // erases, and nothing may reference createServerFn.
    const source = renderModule([
      {
        key: "site/actions/newsletter/subscribe",
        input: "SubscribeProps",
        output: "void",
        imports: [{ name: "SubscribeProps", source: "../src/actions/newsletter/subscribe" }],
      },
    ]);
    const importStatements = source.match(/^import .*/gm) ?? [];
    expect(importStatements.length).toBeGreaterThan(0);
    expect(importStatements.every((line) => line.startsWith("import type "))).toBe(true);
    expect(source).not.toContain("createServerFn");
    expect(source).toContain("TYPES ONLY");
  });

  it("emits no import at all when nothing needs one", () => {
    const source = renderModule([
      { key: "site/loaders/x", input: "unknown", output: "void", imports: [] },
    ]);
    expect(source.match(/^import .*/gm)).toBeNull();
    expect(source).toContain('"site/loaders/x"');
  });

  it("is deterministic, so the incremental digest stays stable", () => {
    const entries = [
      {
        key: "site/loaders/x",
        input: "unknown",
        output: "A",
        imports: [{ name: "A", source: "../a" }],
      },
    ];
    expect(renderModule(entries)).toBe(renderModule(entries));
  });
});
