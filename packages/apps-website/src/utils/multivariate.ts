import type { MultivariateFlag, Variant } from "../types";

/**
 * @title Multivariate
 */
export interface MultivariateProps<T> {
	/**
	 * @minItems 1
	 * @addBehavior 1
	 */
	variants: Variant<T>[];
}

/**
 * @title Variant
 * @label hidden
 */
export default function multivariate<T>(props: MultivariateProps<T>): MultivariateFlag<T> {
	return props;
}
