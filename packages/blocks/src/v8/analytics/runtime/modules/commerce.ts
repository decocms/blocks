/** Commerce is a module, not core.
 *
 *  These helpers are sugar over `track`: `addToCart({...})` and
 *  `track("add_to_cart", {...})` produce the identical event. Their value is type safety
 *  and IDE discovery, which is a build-time concern — so the core has no reason to carry
 *  them, and a site that never sells anything has no reason to download them.
 *
 *  Event names are GA4's, because the deco framework already emits those and existing
 *  experiment queries already join on them. Whoever prescribes a different vocabulary
 *  fragments the market rather than unifying it — Segment calls this `Product Added`. */
type Primitive = string | number | boolean;
type Props = Record<string, Primitive>;

type Money = {
  value?: number;
  currency?: string;
  items?: number;
  itemIds?: string[];
  props?: Props;
};

window.__dqRegister?.((enqueue, api: Record<string, unknown>) => {
  const of =
    (name: string) =>
    (m: Money = {}) =>
      enqueue(name, m.props, {
        value: m.value,
        currency: m.currency,
        items_count: m.items,
        item_ids: m.itemIds,
      });

  api.viewItemList = of("view_item_list");
  api.selectItem = of("select_item");
  api.viewItem = of("view_item");
  api.addToCart = of("add_to_cart");
  api.removeFromCart = of("remove_from_cart");
  api.beginCheckout = of("begin_checkout");

  /** transaction_id is what stops a purchase being counted twice when the customer
   *  reloads the confirmation page — the most common e-commerce analytics bug, and one
   *  that lands straight in reported revenue.
   *
   *  URGENT, the last argument. Core flushes the first event of a page load and then
   *  batches until 50 events, `flushMs` (10s), or the page ending — the right trade for a
   *  scroll depth and the wrong one for money. Most visits are shorter than ten seconds,
   *  so a purchase in a short session rides entirely on a beacon fired while the page is
   *  being torn down, and that beacon is what a slow device is worst at. Measured on the CI
   *  runner, which is slower than a laptop and therefore closer to a real phone: a purchase
   *  fired and the tab closed stored nothing, intermittently, while passing every time on a
   *  laptop.
   *
   *  The cost is bounded by CONVERSIONS rather than by traffic — at most one extra request
   *  per visit, on the small fraction of visits that convert. Deliberately not the other
   *  six: an abandoned cart is a funnel number, and losing a funnel number is not losing
   *  revenue. A cart that precedes a purchase in the same queue rides along anyway, because
   *  a flush drains the queue rather than one event. */
  api.purchase = (m: Money & { transactionId: string }) =>
    enqueue(
      "purchase",
      m.props,
      {
        value: m.value,
        currency: m.currency,
        items_count: m.items,
        item_ids: m.itemIds,
        transaction_id: m.transactionId,
      },
      true,
    );
});
