import { describe, expect, it } from "vitest";
import { stripHTML } from "./html";

describe("stripHTML", () => {
	it("strips HTML tags from string", () => {
		expect(stripHTML("<p>Hello <strong>World</strong></p>")).toBe("Hello World");
	});

	it("returns plain text unchanged", () => {
		expect(stripHTML("no tags here")).toBe("no tags here");
	});

	it("handles empty string", () => {
		expect(stripHTML("")).toBe("");
	});

	it("strips self-closing tags", () => {
		expect(stripHTML("Hello<br/>World")).toBe("HelloWorld");
	});

	it("strips nested tags", () => {
		expect(stripHTML("<div><p><span>text</span></p></div>")).toBe("text");
	});
});
