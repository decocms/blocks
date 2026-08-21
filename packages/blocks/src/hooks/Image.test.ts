import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getImageQuality,
	getOptimizedMediaUrl,
	getSrcSet,
	type ImageQuality,
	registerImageQuality,
} from "./Image";

describe("getOptimizedMediaUrl", () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;
	let prevNodeEnv: string | undefined;

	beforeEach(() => {
		prevNodeEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = "development";
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
		if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = prevNodeEnv;
	});

	it("returns empty string and warns when src is undefined", () => {
		const result = getOptimizedMediaUrl({
			originalSrc: undefined as unknown as string,
			width: 100,
			fit: "cover",
		});
		expect(result).toBe("");
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0][0]).toMatch(/empty\/undefined src/);
	});

	it("returns empty string when src is empty", () => {
		const result = getOptimizedMediaUrl({
			originalSrc: "",
			width: 100,
			fit: "cover",
		});
		expect(result).toBe("");
	});

	it("returns empty string when src is null", () => {
		const result = getOptimizedMediaUrl({
			originalSrc: null as unknown as string,
			width: 100,
			fit: "cover",
		});
		expect(result).toBe("");
	});

	it("does NOT warn in production for missing src", () => {
		process.env.NODE_ENV = "production";
		const result = getOptimizedMediaUrl({
			originalSrc: undefined as unknown as string,
			width: 100,
			fit: "cover",
		});
		expect(result).toBe("");
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it("returns data URI as-is", () => {
		const dataUri = "data:image/png;base64,iVBORw0KGgo=";
		expect(
			getOptimizedMediaUrl({
				originalSrc: dataUri,
				width: 100,
				fit: "cover",
			}),
		).toBe(dataUri);
	});

	it("routes through Deco image CDN for arbitrary src", () => {
		const result = getOptimizedMediaUrl({
			originalSrc: "https://cdn.example.com/foo.jpg",
			width: 200,
			fit: "cover",
		});
		expect(result).toContain("/image?");
		expect(result).toContain("width=200");
		expect(result).toContain("fit=cover");
		expect(result).toContain("src=https://cdn.example.com/foo.jpg");
	});
});

describe("getSrcSet", () => {
	it("returns undefined when src is undefined", () => {
		expect(getSrcSet(undefined as unknown as string, 100)).toBeUndefined();
	});

	it("returns undefined when src is empty", () => {
		expect(getSrcSet("", 100)).toBeUndefined();
	});

	it("produces a srcset string for valid src", () => {
		const result = getSrcSet("https://cdn.example.com/foo.jpg", 100);
		expect(result).toBeDefined();
		// Each factor entry is "<url> <width>w".
		expect(result).toMatch(/\d+w/);
		expect(result).toContain("foo.jpg");
	});
});

describe("registerImageQuality", () => {
	// Module-level setter, so every test has to put it back or it leaks into
	// the rest of the file.
	afterEach(() => {
		registerImageQuality(undefined);
	});

	it("emits no quality param by default", () => {
		// The guarantee that makes this safe to land: every site that does not
		// opt in keeps byte-identical URLs, so no CDN cache is invalidated.
		expect(getImageQuality()).toBeUndefined();
		const result = getOptimizedMediaUrl({
			originalSrc: "https://cdn.example.com/foo.jpg",
			width: 200,
			fit: "cover",
		});
		expect(result).not.toContain("quality");
	});

	it("emits the registered quality for CDN-routed images", () => {
		registerImageQuality("high");
		const result = getOptimizedMediaUrl({
			originalSrc: "https://cdn.example.com/foo.jpg",
			width: 200,
			fit: "cover",
		});
		expect(result).toContain("quality=high");
	});
	it("pins the exact URL, param order included", () => {
		// Param ORDER is part of the CDN cache key, and `toContain` cannot see
		// it: reordering the params would keep every other assertion here green
		// while cold-caching every image on every site. It is also the property
		// that lets a site swap its node_modules patch for this setter without a
		// cache flush, so it needs a real equality check.
		registerImageQuality("high");
		expect(
			getOptimizedMediaUrl({
				originalSrc: "https://cdn.example.com/foo.jpg",
				width: 200,
				height: 300,
				fit: "cover",
			}),
		).toBe(
			"https://decoims.com/image?fit=cover&width=200&height=300&quality=high&src=https://cdn.example.com/foo.jpg",
		);
	});

	it("carries the quality into every srcset entry", () => {
		registerImageQuality("high");
		const result = getSrcSet("https://cdn.example.com/foo.jpg", 100);
		const entries = result?.split(", ") ?? [];
		expect(entries.length).toBeGreaterThan(1);
		for (const entry of entries) {
			expect(entry).toContain("quality=high");
		}
	});

	it("leaves VTEX sources alone — they resize via their own path syntax", () => {
		registerImageQuality("high");
		const result = getOptimizedMediaUrl({
			originalSrc:
				"https://acme.vtexassets.com/arquivos/ids/123456/product.jpg?v=1",
			width: 200,
			height: 300,
			fit: "cover",
		});
		expect(result).toContain("/arquivos/ids/123456-200-300/");
		expect(result).not.toContain("quality");
	});

	it("treats an empty string as unset, for untyped callers", () => {
		// Unreachable from TypeScript now that the parameter is a union, but a
		// value read from env or CMS config arrives as a plain string, so the
		// runtime guard still earns its keep.
		registerImageQuality("" as unknown as ImageQuality);
		expect(getImageQuality()).toBeUndefined();
	});
});
