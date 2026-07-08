import type { MultivariateFlag } from "../types";
import multivariate, { type MultivariateProps } from "../utils/multivariate";

export type Message = string;

/**
 * @title Message Variants
 */
export default function Message(props: MultivariateProps<Message>): MultivariateFlag<Message> {
  return multivariate(props);
}
