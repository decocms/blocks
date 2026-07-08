import { describe, expect, it } from "vitest";
import { configure } from "../mod";

describe("blog module", () => {
	it("returns AppDefinition with name 'blog' and manifest", async () => {
		const app = await configure({}, async () => null);
		expect(app.name).toBe("blog");
		expect(app.manifest).toBeDefined();
		expect(app.state).toEqual({});
	});
});
