import type { ImageWidget } from "@decocms/apps-website/types";

/**
 * @titleBy name
 * @widget author
 */
export interface Author {
	name: string;
	email: string;
	avatar?: ImageWidget;
	jobTitle?: string;
	company?: string;
}

export interface Category {
	name: string;
	slug: string;
}

export interface BlogPost {
	title: string;
	excerpt: string;
	/**
	 * @title Main image
	 */
	image?: ImageWidget;
	/**
	 * @title Alt text for the image
	 */
	alt?: string;
	/**
	 * @widget blog
	 * @collection authors
	 */
	authors?: Author[];
	/**
	 * @widget blog
	 * @collection categories
	 */
	categories?: Category[];
	/**
	 * @format date
	 */
	date: string;
	slug: string;
	/**
	 * @title Post Content
	 * @format rich-text
	 */
	content?: string;
	/**
	 * @title Sections
	 * @label hidden
	 * @changeable true
	 */
	sections?: unknown[];
	/**
	 * @title SEO
	 */
	seo?: Seo;
	/**
	 * @title ReadTime in minutes
	 */
	readTime?: number;
	/**
	 * @title Extra Props
	 */
	extraProps?: ExtraProps[];
	id?: string;
}

export interface ExtraProps {
	key: string;
	value: string;
}

export interface Seo {
	title?: string;
	description?: string;
	image?: ImageWidget;
	canonical?: string;
	noIndexing?: boolean;
}

export interface BlogPostPage {
	"@type": "BlogPostPage";
	post: BlogPost;
	seo?: Seo | null;
}

export type SortBy = "date_desc" | "date_asc" | "title_asc" | "title_desc";

export interface PageInfo {
	nextPage?: string;
	previousPage?: string;
	currentPage: number;
	records?: number;
	recordPerPage?: number;
}

export interface BlogPostListingPage {
	posts: BlogPost[];
	pageInfo: PageInfo;
	seo: Seo;
}
