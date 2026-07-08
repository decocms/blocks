import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@decocms/blocks/cms", () => ({
	loadBlocks: vi.fn(),
}));

import { loadBlocks } from "@decocms/blocks/cms";
import { getRecordsByPath } from "../core/records";

const mockLoadBlocks = loadBlocks as ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.clearAllMocks();
});

describe("getRecordsByPath", () => {
	it("extracts records matching path prefix", () => {
		mockLoadBlocks.mockReturnValue({
			"collections/blog/posts/hello": {
				name: "collections/blog/posts/hello",
				post: { title: "Hello", slug: "hello" },
			},
			"collections/blog/posts/world": {
				name: "collections/blog/posts/world",
				post: { title: "World", slug: "world" },
			},
		});

		const result = getRecordsByPath("collections/blog/posts", "post");
		expect(result).toHaveLength(2);
		expect(result).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ title: "Hello", slug: "hello" }),
				expect.objectContaining({ title: "World", slug: "world" }),
			]),
		);
	});

	it("skips non-object blocks", () => {
		mockLoadBlocks.mockReturnValue({
			"collections/blog/posts/a": "not-an-object",
			"collections/blog/posts/b": null,
			"collections/blog/posts/c": {
				name: "collections/blog/posts/c",
				post: { title: "C" },
			},
		});

		const result = getRecordsByPath("collections/blog/posts", "post");
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual(expect.objectContaining({ title: "C" }));
	});

	it("skips blocks without the accessor field", () => {
		mockLoadBlocks.mockReturnValue({
			"collections/blog/posts/x": {
				name: "collections/blog/posts/x",
				other: { title: "X" },
			},
		});

		const result = getRecordsByPath("collections/blog/posts", "post");
		expect(result).toEqual([]);
	});

	it("derives id from block name", () => {
		mockLoadBlocks.mockReturnValue({
			"collections/blog/posts/my-post": {
				name: "collections/blog/posts/my-post",
				post: { title: "My Post" },
			},
		});

		const result = getRecordsByPath<{ title: string; id?: string }>(
			"collections/blog/posts",
			"post",
		);
		expect(result[0].id).toBe("my-post");
	});

	it("returns empty array when no blocks match", () => {
		mockLoadBlocks.mockReturnValue({
			"collections/blog/categories/cat": {
				name: "collections/blog/categories/cat",
				category: { name: "Cat" },
			},
		});

		const result = getRecordsByPath("collections/blog/posts", "post");
		expect(result).toEqual([]);
	});
});
