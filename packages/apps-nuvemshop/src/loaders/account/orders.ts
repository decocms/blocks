import { listOrders, requireCustomerId } from "../../utils/accountData";
import type { Order } from "../../utils/orders";

export interface Props {
  /** @title Page */
  page?: number;
  /** @title Orders per page (max 50) */
  perPage?: number;
}

/**
 * @title Nuvemshop - Customer orders
 * @description The logged-in buyer's orders, newest first. Only orders owned by the session customer are returned.
 */
export default async function orders(props: Props): Promise<Order[]> {
  return listOrders(await requireCustomerId(), props ?? {});
}

export const cache = "no-store";
