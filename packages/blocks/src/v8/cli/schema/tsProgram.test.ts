// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { CliError } from "../root";

vi.mock("typescript", () => {
  throw new Error("Cannot find package 'typescript'");
});

describe("loading the app's typescript", () => {
  it("says how to fix a missing typescript peer", async () => {
    const { loadTypeScript } = await import("./tsProgram");
    const error = await loadTypeScript().catch((e) => e);
    expect(error).toBeInstanceOf(CliError);
    expect(error.message).toBe(
      "deco schema reads your types with TypeScript, which isn't installed: add typescript to your devDependencies",
    );
  });
});
