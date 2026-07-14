import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Project } from "ts-morph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EITRI_FORMAT_ALIASES,
  WIDGET_TYPE_FORMATS,
  applyWidgetFormat,
  definitionIdForPath,
  normalizeFormats,
  typeToJsonSchema,
} from "./generate-schema";

describe("definitionIdForPath", () => {
  it("is repo-relative, never absolute", () => {
    const id = definitionIdForPath(
      "/Users/anyone/code/mysite/src/sections/Hero.tsx",
      "/Users/anyone/code/mysite",
    );
    expect(Buffer.from(id, "base64").toString()).toBe("src/sections/Hero.tsx");
  });

  it("normalizes file:// prefixes from ts-morph", () => {
    const id = definitionIdForPath(
      "file:///Users/anyone/code/mysite/src/sections/Hero.tsx",
      "/Users/anyone/code/mysite",
    );
    expect(Buffer.from(id, "base64").toString()).toBe("src/sections/Hero.tsx");
  });
});

describe("normalizeFormats (Eitri @format aliases)", () => {
  it("remaps a known alias in a nested prop schema", () => {
    const defs = {
      "abc@Props": {
        type: "object",
        properties: {
          datetime: { type: "string", format: "datetime", title: "Publish date." },
          post: { type: "string", format: "textarea" },
        },
      },
    };
    normalizeFormats(defs, EITRI_FORMAT_ALIASES);
    expect(defs["abc@Props"].properties.datetime.format).toBe("date-time");
    // textarea is already a valid widget format — left untouched.
    expect(defs["abc@Props"].properties.post.format).toBe("textarea");
  });

  it("recurses through arrays and leaves unknown formats alone", () => {
    const node = {
      items: [{ format: "datetime" }, { format: "email" }],
    };
    normalizeFormats(node, EITRI_FORMAT_ALIASES);
    expect(node.items[0].format).toBe("date-time");
    expect(node.items[1].format).toBe("email");
  });

  it("is a no-op on primitives / null", () => {
    expect(() => normalizeFormats(null, EITRI_FORMAT_ALIASES)).not.toThrow();
    expect(() => normalizeFormats("datetime", EITRI_FORMAT_ALIASES)).not.toThrow();
  });
});

describe("applyWidgetFormat", () => {
  it("recovers an unresolved widget alias (empty schema) as string + format", () => {
    // When a widget alias like `Color` is imported from a module ts-morph can't
    // resolve (remote/CDN), the type comes through as `any` and typeToJsonSchema
    // returns {}. The intended widget must still be recovered.
    const schema: any = {};
    applyWidgetFormat(schema, "Color");
    expect(schema).toEqual({ type: "string", format: "color" });
  });

  it.each(Object.entries(WIDGET_TYPE_FORMATS))(
    "recovers the %s alias to { type: string, format: %s } from an empty schema",
    (alias, format) => {
      const schema: any = {};
      applyWidgetFormat(schema, alias);
      expect(schema).toEqual({ type: "string", format });
    },
  );

  it("applies the format to a resolved string schema", () => {
    const schema: any = { type: "string" };
    applyWidgetFormat(schema, "Color");
    expect(schema).toEqual({ type: "string", format: "color" });
  });

  it("does not overwrite a schema that resolved to a $ref", () => {
    const schema: any = { $ref: "#/definitions/Foo" };
    applyWidgetFormat(schema, "Color");
    expect(schema).toEqual({ $ref: "#/definitions/Foo" });
  });

  it("does not touch a schema for a non-widget type hint", () => {
    const schema: any = {};
    applyWidgetFormat(schema, "SomeRandomType");
    expect(schema).toEqual({});
  });
});

describe("typeToJsonSchema with an unresolvable widget alias import", () => {
  it("emits { type: string, format: color } for a Color field imported from a CDN", () => {
    const project = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: { skipLibCheck: true, noResolve: false },
    });

    // The import target is not resolvable, mirroring apps that import `Color`
    // from a remote deco-cx/apps CDN URL — `Color` therefore resolves to `any`.
    const sf = project.createSourceFile(
      "props.ts",
      `
        import type { Color } from "https://cdn.example.com/admin/widgets.ts";

        export interface Props {
          /** @title Cor do Texto */
          textLeftColor?: Color;
        }
      `,
    );

    const propsType = sf.getInterfaceOrThrow("Props").getType();
    const schema = typeToJsonSchema(propsType);

    expect(schema.type).toBe("object");
    expect(schema.properties.textLeftColor).toEqual({
      title: "Cor do Texto",
      type: "string",
      format: "color",
    });
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Default output path (.deco/) + legacy warning — subprocess, mirrors the
// pattern in generate-sections.test.ts. generate-schema.ts IS guarded by
// isMainModule(), but it's still driven as a subprocess here so the CLI's
// argv-parsed OUT_REL/legacy-check top-level code runs against a real cwd.
// ---------------------------------------------------------------------------

const SCRIPT = path.resolve(__dirname, "generate-schema.ts");

function runGenerator(
  args: string[],
  opts: { cwd?: string } = {},
): { stdout: string; stderr: string; code: number } {
  const r = cp.spawnSync("npx", ["tsx", SCRIPT, ...args], { encoding: "utf8", cwd: opts.cwd });
  return { stdout: r.stdout || "", stderr: r.stderr || "", code: r.status ?? 0 };
}

describe("generate-schema default output path (.deco/)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "generate-schema-defaults-"));
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2020",
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "react-jsx",
          skipLibCheck: true,
          strict: true,
        },
      }),
    );
    const sectionsDir = path.join(tmpDir, "src", "sections");
    fs.mkdirSync(sectionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sectionsDir, "Hero.tsx"),
      [
        "export interface Props {",
        "  title: string;",
        "}",
        "export default function Hero(props: Props) { return null; }",
      ].join("\n"),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes to .deco/meta.gen.json when no --out flag is passed", () => {
    const { code } = runGenerator(["--skip-apps"], { cwd: tmpDir });
    expect(code).toBe(0);

    const newDefault = path.join(tmpDir, ".deco", "meta.gen.json");
    expect(fs.existsSync(newDefault)).toBe(true);
    const meta = JSON.parse(fs.readFileSync(newDefault, "utf-8"));
    expect(meta.manifest.blocks.sections).toHaveProperty("site/sections/Hero.tsx");
  }, 30_000);

  it("warns once to stderr naming both paths when the OLD default file exists and no --out is passed, but still writes the NEW default", () => {
    const oldDefaultDir = path.join(tmpDir, "src", "server", "admin");
    fs.mkdirSync(oldDefaultDir, { recursive: true });
    fs.writeFileSync(path.join(oldDefaultDir, "meta.gen.json"), "{}");

    const { code, stderr } = runGenerator(["--skip-apps"], { cwd: tmpDir });
    expect(code).toBe(0);

    expect(stderr).toContain("src/server/admin/meta.gen.json");
    expect(stderr).toContain(".deco/meta.gen.json");
    expect(stderr).toContain("Move the file and update its importers");

    const newDefault = path.join(tmpDir, ".deco", "meta.gen.json");
    expect(fs.existsSync(newDefault)).toBe(true);
  }, 30_000);

  it("does not warn when an explicit --out is passed, even if the OLD default file exists", () => {
    const oldDefaultDir = path.join(tmpDir, "src", "server", "admin");
    fs.mkdirSync(oldDefaultDir, { recursive: true });
    fs.writeFileSync(path.join(oldDefaultDir, "meta.gen.json"), "{}");

    const explicitOut = path.join(tmpDir, "custom", "meta.gen.json");
    const { code, stderr } = runGenerator(["--skip-apps", "--out", explicitOut], { cwd: tmpDir });
    expect(code).toBe(0);

    expect(stderr).not.toContain("Generator default output moved");
    expect(fs.existsSync(explicitOut)).toBe(true);
  }, 30_000);
});
