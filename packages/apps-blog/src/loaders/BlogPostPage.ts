import { getRecordsByPath } from "../core/records";
import type { BlogPost, BlogPostPage } from "../types";

const COLLECTION_PATH = "collections/blog/posts";
const ACCESSOR = "post";

export interface Props {
	slug: string;
}

/**
 * @title BlogPostPage
 * @description Fetches a specific blog post page by its slug.
 */
export default function BlogPostPageLoader(
	props: Props & { __pageUrl?: string },
	req?: Request,
): BlogPostPage | null {
	const { slug } = props;
	const posts = getRecordsByPath<BlogPost>(COLLECTION_PATH, ACCESSOR);

	const rawUrl = req?.url ?? props.__pageUrl ?? "http://localhost/";
	const url = new URL(rawUrl);
	const post = posts.find((p) => p?.slug === slug);

	if (!post) return null;

	return {
		"@type": "BlogPostPage",
		post,
		seo: {
			title: post?.seo?.title || post?.title,
			description: post?.seo?.description || post?.excerpt,
			canonical: post?.seo?.canonical || url.href,
			image: post?.seo?.image || post?.image,
			noIndexing: post?.seo?.noIndexing || false,
		},
	};
}
