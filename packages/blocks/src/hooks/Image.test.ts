import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOptimizedMediaUrl, getSrcSet } from "./Image";

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
