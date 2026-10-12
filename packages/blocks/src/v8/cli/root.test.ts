// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFixture, type Fixture } from "./__tests__/fixture";
import { CliError, findDecoRoot } from "./root";

let fixture: Fixture;
afterEach(() => fixture?.remove());

describe("finding the .deco folder", () => {
  it("walks up from the current folder to the first folder with a .deco/", () => {
    fixture = createFixture();
    const deep = path.join(fixture.root, "src", "components", "ui");
    fs.mkdirSync(deep, { recursive: true });
    expect(findDecoRoot({ cwd: deep })).toBe(fixture.root);
  });

  it("uses the folder itself when it has the .deco/", () => {
    fixture = createFixture();
    expect(findDecoRoot({ cwd: fixture.root })).toBe(fixture.root);
  });

  it("takes --root relative to the current folder (a monorepo app)", () => {
    fixture = createFixture();
    fixture.write("apps/storefront/.deco/blocks/.keep", "");
    expect(findDecoRoot({ cwd: fixture.root, root: "apps/storefront" })).toBe(
      path.join(fixture.root, "apps/storefront"),
    );
  });

  it("fails with the documented message when nothing on the way up has a .deco/", () => {
    fixture = createFixture();
    fs.rmSync(path.join(fixture.root, ".deco"), { recursive: true });
    const cwd = path.join(fixture.root, "src");
    expect(() => findDecoRoot({ cwd })).toThrow(CliError);
    expect(() => findDecoRoot({ cwd })).toThrow(
      `no .deco/ found from ${cwd}; run inside your app or pass --root`,
    );
  });

  it("fails when --root has no .deco/", () => {
    fixture = createFixture();
    expect(() => findDecoRoot({ cwd: fixture.root, root: "src" })).toThrow(/no \.deco\/ in .*src/);
  });
});
