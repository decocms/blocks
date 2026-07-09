import type { ImageWidget, MultivariateFlag } from "../types";
import multivariate, { type MultivariateProps } from "../utils/multivariate";

/**
 * @title Image Variants
 */
export default function Image(
  props: MultivariateProps<ImageWidget>,
): MultivariateFlag<ImageWidget> {
  return multivariate(props);
}
