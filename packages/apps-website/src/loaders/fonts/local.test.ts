import { describe, expect, it } from "vitest";
import localFonts from "./local";

describe("localFonts", () => {
	it("returns empty family and stylesheet for no fonts", () => {
		const result = localFonts({ fonts: [] });
		expect(result.family).toBe("");
		expect(result.styleSheet).toBe("");
	});

	it("generates @font-face for a single font", () => {
		const result = localFonts({
			fonts: [
				{
					family: "CustomFont",
					variations: [{ weight: "400", italic: false, src: "https://cdn.example.com/font.woff2" }],
				},
			],
		});

		expect(result.family).toBe("CustomFont");
		expect(result.styleSheet).toContain("@font-face");
		expect(result.styleSheet).toContain("font-family: 'CustomFont'");
		expect(result.styleSheet).toContain("font-weight: 400");
		expect(result.styleSheet).toContain("font-style: normal");
		expect(result.styleSheet).toContain("format('woff2')");
	});

	it("generates italic font-face", () => {
		const result = localFonts({
			fonts: [
				{
					family: "CustomFont",
					variations: [
						{ weight: "700", italic: true, src: "https://cdn.example.com/font-bold-italic.woff2" },
					],
				},
			],
		});

		expect(result.styleSheet).toContain("font-style: italic");
		expect(result.styleSheet).toContain("font-weight: 700");
	});

	it("merges duplicate font families", () => {
		const result = localFonts({
			fonts: [
				{
					family: "Inter",
					variations: [{ weight: "400", src: "https://cdn.example.com/inter-400.woff2" }],
				},
				{
					family: "Inter",
					variations: [{ weight: "700", src: "https://cdn.example.com/inter-700.woff2" }],
				},
			],
		});

		expect(result.family).toBe("Inter");
		expect(result.styleSheet).toContain("font-weight: 400");
		expect(result.styleSheet).toContain("font-weight: 700");
	});

	it("detects font format from extension", () => {
		const ttfResult = localFonts({
			fonts: [{ family: "F", variations: [{ weight: "400", src: "https://x.com/f.ttf" }] }],
		});
		expect(ttfResult.styleSheet).toContain("format('truetype')");

		const woffResult = localFonts({
			fonts: [{ family: "F", variations: [{ weight: "400", src: "https://x.com/f.woff" }] }],
		});
		expect(woffResult.styleSheet).toContain("format('woff')");
	});
});
