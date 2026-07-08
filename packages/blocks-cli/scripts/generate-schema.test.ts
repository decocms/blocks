import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import {
  WIDGET_TYPE_FORMATS,
  applyWidgetFormat,
  definitionIdForPath,
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
  });
});
