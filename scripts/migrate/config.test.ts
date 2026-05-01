import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_SECTION_CONVENTIONS,
	loadConfig,
	resolveSectionConventions,
	validateConfig,
} from "./config";

describe("loadConfig", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns null when the config file is missing", () => {
		expect(loadConfig(tmpDir)).toBeNull();
	});

	it("loads valid JSON", () => {
		const content = JSON.stringify({
			sectionConventions: { extend: { sync: ["MySection"] } },
		});
		fs.writeFileSync(
			path.join(tmpDir, ".deco-migrate.config.json"),
			content,
			"utf-8",
		);
		const config = loadConfig(tmpDir);
		expect(config).toEqual({
			sectionConventions: { extend: { sync: ["MySection"] } },
		});
	});

	it("throws with a helpful error on malformed JSON", () => {
		fs.writeFileSync(
			path.join(tmpDir, ".deco-migrate.config.json"),
			"not valid json{",
			"utf-8",
		);
		expect(() => loadConfig(tmpDir)).toThrow(
			/Failed to parse.*Expected valid JSON/s,
		);
	});
});

describe("resolveSectionConventions", () => {
	it("returns the defaults when config is null", () => {
		const sets = resolveSectionConventions(null);
		expect(sets.eagerSync.has("UtilLinks")).toBe(true);
		expect(sets.sync.has("ProductShelf")).toBe(true);
		expect(sets.listingCache.has("ProductShelf")).toBe(true);
		expect(sets.staticCache.has("Faq")).toBe(true);
	});

	it("preserves all default eagerSync entries", () => {
		const sets = resolveSectionConventions(null);
		for (const name of DEFAULT_SECTION_CONVENTIONS.eagerSync ?? []) {
			expect(sets.eagerSync.has(name)).toBe(true);
		}
	});

	it("extend mode adds to defaults", () => {
		const sets = resolveSectionConventions({
			sectionConventions: {
				extend: { sync: ["MySection"], staticCache: ["MyStatic"] },
			},
		});
		// Default still present
		expect(sets.sync.has("ProductShelf")).toBe(true);
		// Extension added
		expect(sets.sync.has("MySection")).toBe(true);
		// Default static still present
		expect(sets.staticCache.has("Faq")).toBe(true);
		// Extension added
		expect(sets.staticCache.has("MyStatic")).toBe(true);
	});

	it("extend mode handles partial extensions (only some categories)", () => {
		const sets = resolveSectionConventions({
			sectionConventions: { extend: { eagerSync: ["FrontFacing"] } },
		});
		// All defaults still present in untouched categories
		expect(sets.sync.has("ProductShelf")).toBe(true);
		expect(sets.staticCache.has("Faq")).toBe(true);
		// Extension added
		expect(sets.eagerSync.has("FrontFacing")).toBe(true);
		// Defaults still present in extended category
		expect(sets.eagerSync.has("UtilLinks")).toBe(true);
	});

	it("replace mode discards defaults", () => {
		const sets = resolveSectionConventions({
			sectionConventions: {
				replace: { sync: ["OnlyThis"] },
			},
		});
		// Default removed
		expect(sets.sync.has("ProductShelf")).toBe(false);
		// Replacement present
		expect(sets.sync.has("OnlyThis")).toBe(true);
		// Untouched categories empty
		expect(sets.eagerSync.size).toBe(0);
		expect(sets.listingCache.size).toBe(0);
		expect(sets.staticCache.size).toBe(0);
	});

	it("replace mode is full replacement, not partial overlay", () => {
		const sets = resolveSectionConventions({
			sectionConventions: {
				replace: {
					eagerSync: ["X"],
					sync: ["Y"],
					listingCache: ["Z"],
					staticCache: ["W"],
				},
			},
		});
		expect(Array.from(sets.eagerSync)).toEqual(["X"]);
		expect(Array.from(sets.sync)).toEqual(["Y"]);
		expect(Array.from(sets.listingCache)).toEqual(["Z"]);
		expect(Array.from(sets.staticCache)).toEqual(["W"]);
	});

	it("returns empty sets when given empty arrays in replace", () => {
		const sets = resolveSectionConventions({
			sectionConventions: { replace: {} },
		});
		expect(sets.eagerSync.size).toBe(0);
		expect(sets.sync.size).toBe(0);
		expect(sets.listingCache.size).toBe(0);
		expect(sets.staticCache.size).toBe(0);
	});

	it("returns defaults when sectionConventions is undefined", () => {
		const sets = resolveSectionConventions({});
		expect(sets.sync.has("ProductShelf")).toBe(true);
	});
});

describe("validateConfig", () => {
	it("accepts an empty config", () => {
		expect(() => validateConfig({})).not.toThrow();
	});

	it("accepts a config with extend", () => {
		expect(() =>
			validateConfig({
				sectionConventions: { extend: { sync: ["Foo"] } },
			}),
		).not.toThrow();
	});

	it("accepts a config with replace", () => {
		expect(() =>
			validateConfig({
				sectionConventions: { replace: { sync: ["Foo"] } },
			}),
		).not.toThrow();
	});

	it("rejects non-object root", () => {
		expect(() => validateConfig("bad")).toThrow(
			/must be a JSON object/,
		);
	});

	it("rejects non-object sectionConventions", () => {
		expect(() => validateConfig({ sectionConventions: "bad" })).toThrow(
			/sectionConventions must be an object/,
		);
	});

	it("rejects non-array values in convention lists", () => {
		expect(() =>
			validateConfig({
				sectionConventions: { extend: { sync: "not-an-array" } },
			}),
		).toThrow(/must be string\[\]/);
	});

	it("rejects non-string entries in convention lists", () => {
		expect(() =>
			validateConfig({
				sectionConventions: { extend: { sync: [1, 2, 3] } },
			}),
		).toThrow(/must be string\[\]/);
	});

	it("ignores unknown top-level fields gracefully", () => {
		expect(() =>
			validateConfig({ unknownField: 123, sectionConventions: {} }),
		).not.toThrow();
	});
});
