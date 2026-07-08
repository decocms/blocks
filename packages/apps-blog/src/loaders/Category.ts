import type { Category } from "../types";

/**
 * @title Category
 * @description Defines a blog post category.
 */
const loader = ({ category }: { category: Category }): Category => category;

export default loader;
