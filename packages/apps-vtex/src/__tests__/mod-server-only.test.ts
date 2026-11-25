/**
 * Generic Master Data CRUD must stay off the HTTP /deco/invoke surface.
 * `serverOnly` matches manifest keys by string, so a rename of the module
 * would silently drop the protection — pin both sides here.
 */

import { describe, expect, it } from "vitest";
import manifest from "../manifest.gen";
import { configure } from "../mod";

describe("vtex app serverOnly", () => {
	it("marks the generic Master Data actions as server-only", async () => {
		const app = await configure({ account: "store" }, async () => null);
		expect(app?.serverOnly).toContain("vtex/actions/masterData");
	});

	it("every serverOnly key exists in the manifest", async () => {
		const app = await configure({ account: "store" }, async () => null);
		const moduleKeys = new Set([
			...Object.keys(manifest.loaders ?? {}),
			...Object.keys(manifest.actions ?? {}),
		]);
		for (const key of app?.serverOnly ?? []) {
			expect(moduleKeys.has(key)).toBe(true);
		}
		expect(Object.keys(manifest.actions["vtex/actions/masterData"])).toEqual(
			expect.arrayContaining(["searchDocumentsFull", "getDocument", "createDocument", "patchDocument"]),
		);
	});
});
