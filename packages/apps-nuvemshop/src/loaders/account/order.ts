import { getOrder, requireCustomerId } from "../../utils/accountData";
import type { OrderDetail } from "../../utils/orders";

export interface Props {
  /** @title Order id */
  orderId: number | string;
}

/**
 * @title Nuvemshop - Customer order
 * @description One order of the logged-in buyer. Not-yours is indistinguishable from not-found (404).
 */
export default async function order(props: Props): Promise<OrderDetail> {
  return getOrder(await requireCustomerId(), props?.orderId);
}

export const cache = "no-store";
