/**
 * Project a VTEX OrderForm down to a requested `CartProjection`.
 *
 * The VTEX checkout API always returns the whole OrderForm from mutation
 * endpoints (bounded only by `expectedOrderFormSections`) — there is no
 * delta/patch response. So "return the minimum" is enforced **server-side**:
 * we take whatever VTEX gave us and shape it into `none` / `summary` /
 * `summary+items` / `minicart` / `raw` before it reaches the browser.
 *
 * Pure function — no I/O, fully unit-testable. All monetary values in the
 * projected output are in major units (VTEX is cents).
 *
 * @see `@decocms/apps-commerce/types/cart` for the agnostic contract.
 */

import type {
  CartItemSlim,
  CartOk,
  CartProjection,
  CartSummary,
  CartSummaryWithItems,
  Minicart,
} from "@decocms/apps-commerce/types";
import type { OrderForm, OrderFormItem } from "../types";
import { type VtexOrderFormToMinicartOptions, vtexOrderFormToMinicart } from "./minicart";

const CENTS_PER_MAJOR = 100;

function fromCents(cents: number | undefined | null): number {
  if (cents == null || !Number.isFinite(cents)) return 0;
  return cents / CENTS_PER_MAJOR;
}

/** Sum of line quantities. */
function countItems(orderForm: OrderForm): number {
  return (orderForm.items ?? []).reduce((sum, i) => sum + (i.quantity ?? 0), 0);
}

function toSummary(orderForm: OrderForm): CartSummary {
  return {
    orderFormId: orderForm.orderFormId ?? null,
    totalItems: countItems(orderForm),
    total: fromCents(orderForm.value),
  };
}

/** Map a VTEX line to the slim, analytics-compatible `CartItemSlim`. */
function toSlimItem(item: OrderFormItem): CartItemSlim {
  return {
    item_id: item.id,
    item_name: item.name ?? item.skuName ?? "",
    item_variant: item.skuName,
    image: item.imageUrl?.replace(/^http:/, "https:") ?? "",
    price: fromCents(item.sellingPrice ?? item.price),
    quantity: item.quantity,
  };
}

export type ProjectOrderFormOptions = VtexOrderFormToMinicartOptions;

/** The projected result type, with VTEX-concrete `minicart`/`raw` payloads. */
export type VtexCartProjectionResult =
  | CartOk
  | CartSummary
  | CartSummaryWithItems
  | Minicart<OrderForm>
  | OrderForm;

/**
 * Shape a VTEX OrderForm into the requested projection.
 *
 * @param orderForm - Raw OrderForm from a VTEX checkout call.
 * @param projection - Desired client-facing shape.
 * @param opts - Storefront overrides forwarded to the `minicart` projection.
 */
export function projectOrderForm(
  orderForm: OrderForm,
  projection: CartProjection,
  opts: ProjectOrderFormOptions = {},
): VtexCartProjectionResult {
  switch (projection) {
    case "none":
      return { ok: true };
    case "summary":
      return toSummary(orderForm);
    case "summary+items":
      return {
        ...toSummary(orderForm),
        items: (orderForm.items ?? []).map(toSlimItem),
      };
    case "minicart":
      return vtexOrderFormToMinicart(orderForm, opts);
    case "raw":
      return orderForm;
  }
}
