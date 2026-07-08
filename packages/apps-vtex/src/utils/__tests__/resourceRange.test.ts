import { describe, expect, it } from "vitest";
import { resourceRange } from "../resourceRange";

describe("resourceRange", () => {
	it("returns from=0 and to=take when skip is 0", () => {
		expect(resourceRange(0, 50)).toEqual({ from: 0, to: 50 });
	});

	it("caps take at 100", () => {
		expect(resourceRange(0, 200)).toEqual({ from: 0, to: 100 });
	});

	it("applies skip offset", () => {
		expect(resourceRange(10, 50)).toEqual({ from: 10, to: 60 });
	});

	it("handles skip + take > 100 by capping take", () => {
		expect(resourceRange(50, 200)).toEqual({ from: 50, to: 150 });
	});

	it("treats negative skip as 0", () => {
		expect(resourceRange(-5, 10)).toEqual({ from: 0, to: 10 });
	});

	it("handles zero take", () => {
		expect(resourceRange(0, 0)).toEqual({ from: 0, to: 0 });
	});

	it("handles take of exactly 100", () => {
		expect(resourceRange(0, 100)).toEqual({ from: 0, to: 100 });
	});
});
