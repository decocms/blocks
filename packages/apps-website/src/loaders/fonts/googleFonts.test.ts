import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import googleFonts from "./googleFonts";

describe("googleFonts", () => {
	let fetchSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns empty font for no fonts", async () => {
		const result = await googleFonts({ fonts: [] });
		expect(result.family).toBe("");
		expect(result.styleSheet).toBe("");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("fetches Google Fonts CSS with two User-Agents", async () => {
		fetchSpy.mockResolvedValue({ text: () => Promise.resolve("/* css */") });

		const result = await googleFonts({
			fonts: [{ family: "Inter", variations: [{ weight: "400" }] }],
		});

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(result.family).toBe("Inter");
		expect(result.styleSheet).toContain("/* css */");
	});

	it("handles fetch errors gracefully", async () => {
		fetchSpy.mockRejectedValue(new Error("Network error"));

		const result = await googleFonts({
			fonts: [{ family: "Roboto", variations: [{ weight: "400" }] }],
		});

		expect(result.family).toBe("Roboto");
		expect(result.styleSheet).toBe("\n");
	});

	it("merges duplicate font families", async () => {
		fetchSpy.mockResolvedValue({ text: () => Promise.resolve("") });

		await googleFonts({
			fonts: [
				{ family: "Inter", variations: [{ weight: "400" }] },
				{ family: "Inter", variations: [{ weight: "700" }] },
			],
		});

		// Should only have one "family" param for "Inter" with merged variations
		const calledUrl = fetchSpy.mock.calls[0][0] as URL;
		const families = calledUrl.searchParams.getAll("family");
		expect(families).toHaveLength(1);
		expect(families[0]).toContain("Inter");
	});
});
