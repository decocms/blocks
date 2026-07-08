import { describe, expect, it } from "vitest";
import { mapLabelledFuzzyToFuzzy } from "../productListingPage";

describe("mapLabelledFuzzyToFuzzy", () => {
	it("translates 'automatic' to 'auto'", () => {
		expect(mapLabelledFuzzyToFuzzy("automatic")).toBe("auto");
	});

	it("translates 'enabled' to '1'", () => {
		expect(mapLabelledFuzzyToFuzzy("enabled")).toBe("1");
	});

	it("translates 'disabled' to '0'", () => {
		expect(mapLabelledFuzzyToFuzzy("disabled")).toBe("0");
	});

	it("returns undefined for missing label", () => {
		expect(mapLabelledFuzzyToFuzzy(undefined)).toBeUndefined();
	});
});
