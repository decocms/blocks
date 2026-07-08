import type { MultivariateFlag } from "../types";
import multivariate, { type MultivariateProps } from "../utils/multivariate";

/**
 * Section type placeholder — the actual Section type is defined by the framework.
 */
type Section = unknown;

/**
 * @title Page Variants
 */
export default function PageVariants(
  props: MultivariateProps<Section[]>,
): MultivariateFlag<Section[]> {
  return multivariate(props);
}
