import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompileRunResult } from "./phase-compile";
import { checkCssCompiles } from "./css-compile-check";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "css-compile-check-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fakeRunner(
  impl: (cmd: string, cwd: string) => CompileRunResult,
): { calls: string[]; runner: (cmd: string, cwd: string) => CompileRunResult } {
  const calls: string[] = [];
  const runner = (cmd: string, cwd: string) => {
    calls.push(cmd);
    return impl(cmd, cwd);
  };
  return { calls, runner };
}

describe("checkCssCompiles", () => {
  it("no-ops when src/styles/app.css doesn't exist", () => {
    const { runner, calls } = fakeRunner(() => ({ ok: true }));
    const result = checkCssCompiles({ sourceDir: tmpDir }, runner);
    expect(result.ran).toBe(false);
    expect(result.passed).toBe(true);
    expect(calls).toEqual([]);
  });

  it("reports a failure with the runner's captured output", () => {
    fs.mkdirSync(path.join(tmpDir, "src", "styles"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "styles", "app.css"), "@import \"tailwindcss\";\n");

    const { runner, calls } = fakeRunner(() => ({
      ok: false,
      output: "Cannot apply unknown utility class `font-bebas-neue`",
    }));
    const result = checkCssCompiles({ sourceDir: tmpDir }, runner);
    expect(result.ran).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.output).toContain("font-bebas-neue");
    expect(calls[0]).toContain("@tailwindcss/cli");
    expect(calls[0]).toContain("src/styles/app.css");
  });

  it("reports success and scans for classes missing from the compiled output", () => {
    fs.mkdirSync(path.join(tmpDir, "src", "styles"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "styles", "app.css"), "@import \"tailwindcss\";\n");
    fs.mkdirSync(path.join(tmpDir, "src", "components"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "src", "components", "Foo.tsx"),
      `export default () => <div className="container-pdp flex" />;\n`,
    );

    const { runner } = fakeRunner((cmd) => {
      const outMatch = cmd.match(/-o\s+(\S+)/);
      const outPath = outMatch![1];
      // Simulate Tailwind having generated CSS for `flex` but not the
      // dropped custom `container-pdp` utility.
      fs.writeFileSync(outPath, ".flex { display: flex; }\n");
      return { ok: true };
    });

    const result = checkCssCompiles({ sourceDir: tmpDir }, runner);
    expect(result.passed).toBe(true);
    expect(result.unmatchedClassWarnings).toContain("container-pdp");
    expect(result.unmatchedClassWarnings).not.toContain("flex");
  });

  it("does not flag classes containing variants/brackets/opacity modifiers (escaping is unreliable)", () => {
    fs.mkdirSync(path.join(tmpDir, "src", "styles"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "styles", "app.css"), "@import \"tailwindcss\";\n");
    fs.mkdirSync(path.join(tmpDir, "src", "components"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "src", "components", "Foo.tsx"),
      `export default () => <div className="hover:underline bg-black/20 w-[100px]" />;\n`,
    );

    const { runner } = fakeRunner((cmd) => {
      const outPath = cmd.match(/-o\s+(\S+)/)![1];
      fs.writeFileSync(outPath, "");
      return { ok: true };
    });

    const result = checkCssCompiles({ sourceDir: tmpDir }, runner);
    expect(result.unmatchedClassWarnings).toEqual([]);
  });

  it("does not treat a data-class attribute's value as a className token", () => {
    fs.mkdirSync(path.join(tmpDir, "src", "styles"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "styles", "app.css"), "@import \"tailwindcss\";\n");
    fs.mkdirSync(path.join(tmpDir, "src", "components"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "src", "components", "Foo.tsx"),
      `export default () => <div data-class="tracking-widget" className="flex" />;\n`,
    );

    const { runner } = fakeRunner((cmd) => {
      const outPath = cmd.match(/-o\s+(\S+)/)![1];
      fs.writeFileSync(outPath, ".flex { display: flex; }\n");
      return { ok: true };
    });

    const result = checkCssCompiles({ sourceDir: tmpDir }, runner);
    expect(result.unmatchedClassWarnings).not.toContain("tracking-widget");
  });
});
