import { getRecordsByPath } from "../core/records";
import type { BlogPost } from "../types";

export interface Props {
	slug: string;
}

/**
 * @title BlogPostItem
 * @description Fetches a single blog post by slug. Returns the BlogPost
 * directly (not wrapped in BlogPostPage).
 */
export default function BlogPostItem(props: Props & { __pageUrl?: string }): BlogPost | null {
	const { slug } = props;
	if (!slug) return null;

	const posts = getRecordsByPath<BlogPost>("collections/blog/posts", "post");
	return posts.find((p) => p?.slug === slug) ?? null;
}
