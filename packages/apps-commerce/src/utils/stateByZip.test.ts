import { describe, expect, it } from "vitest";
import getStateFromZip from "./stateByZip";

describe("getStateFromZip", () => {
	it("returns SP for São Paulo ZIP", () => {
		expect(getStateFromZip("01001000")).toBe("SP");
	});

	it("returns RJ for Rio de Janeiro ZIP", () => {
		expect(getStateFromZip("20000000")).toBe("RJ");
	});

	it("returns MG for Minas Gerais ZIP", () => {
		expect(getStateFromZip("30000000")).toBe("MG");
	});

	it("returns RS for Rio Grande do Sul ZIP", () => {
		expect(getStateFromZip("90000000")).toBe("RS");
	});

	it("strips non-numeric characters", () => {
		expect(getStateFromZip("01001-000")).toBe("SP");
		expect(getStateFromZip("01.001-000")).toBe("SP");
	});

	it("returns empty string for invalid ZIP", () => {
		expect(getStateFromZip("00000000")).toBe("");
		expect(getStateFromZip("")).toBe("");
	});

	it("handles boundary: AM upper range", () => {
		expect(getStateFromZip("69299999")).toBe("AM");
	});

	it("handles boundary: RR range", () => {
		expect(getStateFromZip("69300000")).toBe("RR");
		expect(getStateFromZip("69399999")).toBe("RR");
	});

	it("handles boundary: AM second range", () => {
		expect(getStateFromZip("69400000")).toBe("AM");
	});

	it("handles boundary: AC range", () => {
		expect(getStateFromZip("69900000")).toBe("AC");
		expect(getStateFromZip("69999999")).toBe("AC");
	});

	it("returns BA for Bahia ZIP", () => {
		expect(getStateFromZip("40000000")).toBe("BA");
	});

	it("returns DF for Brasília ZIP", () => {
		expect(getStateFromZip("70000000")).toBe("DF");
	});
});
