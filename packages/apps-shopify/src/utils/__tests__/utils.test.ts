import { describe, expect, it } from "vitest";
import { parseProductSlug } from "../utils";

describe("parseProductSlug", () => {
	it("splits a trailing variant id off the handle", () => {
		expect(parseProductSlug("oversize-t-shirt-40306064162993")).toEqual({
			handle: "oversize-t-shirt",
			skuId: 40306064162993,
		});
	});

	it("keeps a short numeric tail as part of the handle", () => {
		expect(parseProductSlug("t-shirt-2")).toEqual({ handle: "t-shirt-2" });
	});

	it("returns an empty handle for a missing slug", () => {
		expect(parseProductSlug(undefined)).toEqual({ handle: "" });
	});
});
