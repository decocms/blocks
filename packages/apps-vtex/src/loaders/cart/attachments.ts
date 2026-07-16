/**
 * `vtex/loaders/cart/attachments` — one item's attachments + offered slots.
 *
 * For a customization UI (engraving, gift wrap, ...) that only needs a single
 * line's attachment state. Fetches just `items` and returns that item's
 * `attachments` (applied) and `attachmentOfferings` (available slots).
 */

import { getOrCreateCartV2 } from "../../actions/checkout";
import type { OrderForm, OrderFormItem } from "../../types";
import { resolveOrderFormId } from "./orderFormId";

export interface CartItemAttachmentsProps {
  orderFormId?: string;
  /** Index of the line whose attachments to read. */
  itemIndex: number;
}

export interface CartItemAttachments {
  orderFormId: string | null;
  itemIndex: number;
  attachments: NonNullable<OrderFormItem["attachments"]>;
  attachmentOfferings: NonNullable<OrderFormItem["attachmentOfferings"]>;
}

export default async function cartItemAttachments(
  props: CartItemAttachmentsProps,
): Promise<CartItemAttachments> {
  const orderFormId = resolveOrderFormId(props.orderFormId);
  const empty: CartItemAttachments = {
    orderFormId: null,
    itemIndex: props.itemIndex,
    attachments: [],
    attachmentOfferings: [],
  };
  if (!orderFormId) return empty;

  const orderForm = (await getOrCreateCartV2({
    orderFormId,
    projection: "raw",
    sections: ["items"],
  })) as OrderForm;

  const item = orderForm.items?.[props.itemIndex];
  if (!item) return { ...empty, orderFormId: orderForm.orderFormId ?? null };

  return {
    orderFormId: orderForm.orderFormId ?? null,
    itemIndex: props.itemIndex,
    attachments: item.attachments ?? [],
    attachmentOfferings: item.attachmentOfferings ?? [],
  };
}
