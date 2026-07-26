import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _truncateForTesting, compile } from "./phase-compile";
import type { CompileRunResult } from "./phase-compile";
import type { MigrationContext } from "./types";

function makeCtx(sourceDir: string, dryRun = false): MigrationContext {
	return {
		sourceDir,
		siteName: "test-site",
		platform: "vtex",
		vtexAccount: null,
		gtmId: null,
		importMap: {},
		discoveredNpmDeps: {},
		themeColors: {},
	tailwindConfig: { colors: {}, fontFamily: {}, screens: {}, safelist: [], safelistPatterns: [], plugins: [], reviewItems: [] },
		fontFamily: null,
		files: [],
		sectionMetas: [],
		islandClassifications: [],
		islandWrapperTargets: new Map(),
		loaderInventory: [],
		scaffoldedFiles: [],
		transformedFiles: [],
		deletedFiles: [],
		movedFiles: [],
		manualReviewItems: [],
		frameworkFindings: [],
		dryRun,
		verbose: false,
	};
}

function fakeRunner(
	responses: Record<string, CompileRunResult>,
): {
	calls: string[];
	runner: (cmd: string, cwd: string) => CompileRunResult;
} {
	const calls: string[] = [];
	const runner = (cmd: string, _cwd: string): CompileRunResult => {
		calls.push(cmd);
		return responses[cmd] ?? { ok: true };
	};
	return { calls, runner };
}

describe("compile (phase 8)", () => {
	let tmpDir: string;
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "compile-test-"));
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
		logSpy.mockRestore();
	});

	it("is a no-op in dry-run mode", () => {
		const ctx = makeCtx(tmpDir, true);
		const { runner, calls } = fakeRunner({});
		const result = compile(ctx, { runner });
		expect(result.skipped).toBe(true);
		expect(result.typecheck.ran).toBe(false);
		expect(result.shouldFail).toBe(false);
		expect(calls).toEqual([]);
	});

	it("skips when node_modules/ is missing", () => {
		const ctx = makeCtx(tmpDir);
		const { runner, calls } = fakeRunner({});
		const result = compile(ctx, { runner });
		expect(result.skipped).toBe(true);
		expect(result.typecheck.ran).toBe(false);
		expect(calls).toEqual([]);
	});

	it("runs typecheck when node_modules/ exists and reports success", () => {
		fs.mkdirSync(path.join(tmpDir, "node_modules"), { recursive: true });
		const ctx = makeCtx(tmpDir);
		const { runner, calls } = fakeRunner({
			"npx tsc --noEmit": { ok: true },
		});
		const result = compile(ctx, { runner });
		expect(result.skipped).toBe(false);
		expect(result.typecheck.ran).toBe(true);
		expect(result.typecheck.passed).toBe(true);
		expect(result.shouldFail).toBe(false);
		expect(calls).toEqual(["npx tsc --noEmit"]);
	});

	it("captures tsc failure output and emits a warning by default", () => {
		fs.mkdirSync(path.join(tmpDir, "node_modules"), { recursive: true });
		const ctx = makeCtx(tmpDir);
		const tscOutput = "src/foo.ts(10,5): error TS2322: Type mismatch.";
		const { runner } = fakeRunner({
			"npx tsc --noEmit": { ok: false, output: tscOutput },
		});
		const result = compile(ctx, { runner });
		expect(result.typecheck.passed).toBe(false);
		expect(result.typecheck.output).toBe(tscOutput);
		// In default (non-strict) mode, failure does not abort the migration.
		expect(result.shouldFail).toBe(false);
	});

	it("promotes tsc failure to abort in --strict mode", () => {
		fs.mkdirSync(path.join(tmpDir, "node_modules"), { recursive: true });
		const ctx = makeCtx(tmpDir);
		const { runner } = fakeRunner({
			"npx tsc --noEmit": { ok: false, output: "TS error" },
		});
		const result = compile(ctx, { runner, strict: true });
		expect(result.typecheck.passed).toBe(false);
		expect(result.shouldFail).toBe(true);
	});

	it("runs vite build only when --with-build is passed", () => {
		fs.mkdirSync(path.join(tmpDir, "node_modules"), { recursive: true });
		const ctx = makeCtx(tmpDir);
		const { runner, calls } = fakeRunner({
			"npx tsc --noEmit": { ok: true },
			"npx vite build": { ok: true },
		});
		const result = compile(ctx, { runner, withBuild: true });
		expect(calls).toEqual(["npx tsc --noEmit", "npx vite build"]);
		expect(result.build.ran).toBe(true);
		expect(result.build.passed).toBe(true);
	});

	it("does not run vite build by default", () => {
		fs.mkdirSync(path.join(tmpDir, "node_modules"), { recursive: true });
		const ctx = makeCtx(tmpDir);
		const { runner, calls } = fakeRunner({
			"npx tsc --noEmit": { ok: true },
		});
		const result = compile(ctx, { runner });
		expect(calls).toEqual(["npx tsc --noEmit"]);
		expect(result.build.ran).toBe(false);
	});

	it("aborts in strict mode when build fails even if typecheck passes", () => {
		fs.mkdirSync(path.join(tmpDir, "node_modules"), { recursive: true });
		const ctx = makeCtx(tmpDir);
		const { runner } = fakeRunner({
			"npx tsc --noEmit": { ok: true },
			"npx vite build": { ok: false, output: "Vite build error" },
		});
		const result = compile(ctx, {
			runner,
			withBuild: true,
			strict: true,
		});
		expect(result.typecheck.passed).toBe(true);
		expect(result.build.passed).toBe(false);
		expect(result.shouldFail).toBe(true);
	});

	it("still runs build after a tsc failure (strict mode aborts at the end)", () => {
		fs.mkdirSync(path.join(tmpDir, "node_modules"), { recursive: true });
		const ctx = makeCtx(tmpDir);
		const { runner, calls } = fakeRunner({
			"npx tsc --noEmit": { ok: false, output: "TS error" },
			"npx vite build": { ok: true },
		});
		const result = compile(ctx, { runner, withBuild: true });
		expect(calls).toEqual(["npx tsc --noEmit", "npx vite build"]);
		expect(result.typecheck.passed).toBe(false);
		expect(result.build.passed).toBe(true);
	});

	it("skips the CSS compile check when src/styles/app.css doesn't exist", () => {
		fs.mkdirSync(path.join(tmpDir, "node_modules"), { recursive: true });
		const ctx = makeCtx(tmpDir);
		const { runner, calls } = fakeRunner({
			"npx tsc --noEmit": { ok: true },
		});
		const result = compile(ctx, { runner });
		expect(result.css.ran).toBe(false);
		expect(calls).toEqual(["npx tsc --noEmit"]);
	});

	it("runs and fails the CSS compile check when app.css exists and the CLI errors", () => {
		fs.mkdirSync(path.join(tmpDir, "node_modules"), { recursive: true });
		fs.mkdirSync(path.join(tmpDir, "src", "styles"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "src", "styles", "app.css"), "@import \"tailwindcss\";\n");
		const ctx = makeCtx(tmpDir);
		const { runner } = fakeRunner({
			"npx tsc --noEmit": { ok: true },
		});
		const cssAwareRunner = (cmd: string, cwd: string) => {
			if (cmd.includes("@tailwindcss/cli")) {
				return { ok: false, output: "Cannot apply unknown utility class `font-bebas-neue`" };
			}
			return runner(cmd, cwd);
		};
		const result = compile(ctx, { runner: cssAwareRunner });
		expect(result.css.ran).toBe(true);
		expect(result.css.passed).toBe(false);
		expect(result.css.output).toContain("font-bebas-neue");
		expect(result.shouldFail).toBe(false); // non-strict: warning only
	});

	it("promotes a CSS compile failure to abort in --strict mode", () => {
		fs.mkdirSync(path.join(tmpDir, "node_modules"), { recursive: true });
		fs.mkdirSync(path.join(tmpDir, "src", "styles"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, "src", "styles", "app.css"), "@import \"tailwindcss\";\n");
		const ctx = makeCtx(tmpDir);
		const cssAwareRunner = (cmd: string): CompileRunResult => {
			if (cmd.includes("@tailwindcss/cli")) return { ok: false, output: "invalid CSS" };
			return { ok: true };
		};
		const result = compile(ctx, { runner: cssAwareRunner, strict: true });
		expect(result.typecheck.passed).toBe(true);
		expect(result.css.passed).toBe(false);
		expect(result.shouldFail).toBe(true);
	});
});

describe("truncate helper", () => {
	it("returns input unchanged when within line limit", () => {
		const input = "line1\nline2\nline3";
		expect(_truncateForTesting(input, 10)).toBe(input);
	});

	it("truncates output exceeding the line limit", () => {
		const lines = Array.from({ length: 100 }, (_, i) => `line${i}`);
		const out = _truncateForTesting(lines.join("\n"), 50);
		const outLines = out.split("\n");
		// 50 kept lines + 1 truncation marker
		expect(outLines).toHaveLength(51);
		expect(outLines[0]).toBe("line0");
		expect(outLines[49]).toBe("line49");
		expect(outLines[50]).toContain("50 more lines truncated");
	});
});
