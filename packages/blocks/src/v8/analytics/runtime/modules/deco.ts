/** Adapter for deco storefronts.
 *
 *  Two jobs, both about not asking a site to instrument twice: read the experiment
 *  assignment the origin already made, and forward the analytics events the framework
 *  already dispatches.
 *
 *  It reads `deco_segment` rather than the event bus for flags because the cookie is set
 *  by the origin before any script runs, so the assignment is on the very first event —
 *  including the pageview. Waiting for the bus would attribute the landing pageview to no
 *  variant, which is the one event an experiment most needs attributed.
 */
import { LIMITS, STOREFRONT_EXP } from "../../shared/contract.ts";

type Props = Record<string, string | number | boolean>;

window.__dqRegister?.((enqueue, api: Record<string, unknown>) => {
  const setExperiment = api.setExperiment as ((k: string, v: string) => void) | undefined;

  // ---- assignment, from the cookie the origin already set ---------------------
  //
  // deco_segment is base64 of URI-encoded JSON: { active: string[], inactiveDrawn: [] }.
  // It carries flag NAMES and nothing else — see deco/runtime/middleware.ts, which writes
  // it from `flag.value` as a boolean.
  //
  // So both lists matter. `inactiveDrawn` means "evaluated for this visitor and came out
  // false", which IS the control group: recording only the active flags would leave an
  // experiment with a treatment arm and no baseline to compare it against, and a
  // conversion rate with nothing to compare it to is not a result.
  try {
    const raw = document.cookie
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("deco_segment="));
    if (raw) {
      const json = JSON.parse(decodeURIComponent(atob(raw.slice("deco_segment=".length))));
      const set = (name: string, variant: string) => {
        // Experiment keys allow hyphens; anything else the Worker normalises and flags.
        if (name && name.length <= LIMITS.expKeyLen) setExperiment?.(name, variant);
      };
      for (const name of json.active ?? []) set(String(name), "on");
      for (const name of json.inactiveDrawn ?? []) set(String(name), "off");
    }
  } catch {
    // A malformed cookie is a site problem, not a reason to stop collecting.
  }

  // ---- the side of a Fresh x TanStack split ------------------------------------
  //
  // `withABTesting` keeps the side in `_deco_bucket` as `<side>:<percent>` (`worker:50`), set at
  // the edge before the document reaches the browser, so it too is on the first event. Recorded
  // as the `storefront` experiment with the names the store Worker stamps on what it sends
  // through `EdgeIngest` -- the two halves of the funnel only group together if they agree, and
  // `STOREFRONT_EXP` is where they do. An unknown side is skipped rather than recorded raw: a
  // third variant nobody emits at the edge would be a funnel with no ruler.
  try {
    const raw = document.cookie
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${STOREFRONT_EXP.cookie}=`));
    const side = raw
      ? decodeURIComponent(raw.slice(STOREFRONT_EXP.cookie.length + 1)).split(":")[0]
      : "";
    const variant = STOREFRONT_EXP.variants[side];
    if (variant) setExperiment?.(STOREFRONT_EXP.name, variant);
  } catch {
    // Same as above: a bad cookie costs the arm, never the collection.
  }

  // ---- events, from the bus the framework already has -------------------------
  //
  // deco dispatches commerce events in the Google Analytics shape. Mapped to our names
  // rather than forwarded verbatim: `add_to_cart` here has a typed value column, and
  // passing GA's nested `ecommerce.items` through as props would put money in a string.
  const NAME_MAP: Record<string, string> = {
    view_item: "view_item",
    view_item_list: "view_item_list",
    select_item: "select_item",
    add_to_cart: "add_to_cart",
    remove_from_cart: "remove_from_cart",
    begin_checkout: "begin_checkout",
    purchase: "purchase",
    search: "$search",
    view_promotion: "view_promotion",
    select_promotion: "select_promotion",
  };

  /** A storefront can hand the bus its products in one of two shapes, and both are deco's.
   *
   *  `items` is the GA4 shape `mapProductToAnalyticsItem` builds. `products` is the schema.org
   *  `Product` itself, which the `DECO` adapter of the Azzas tracking SDK expects and builds the
   *  GA4 payload from on its own -- the FARM sends every commerce event that way. Reading only
   *  `items` stored 94k `add_to_cart` from the FARM in five days with not one item id or value:
   *  the event names arrived, so every panel looked instrumented, and nothing said which product.
   *
   *  The id follows `mapProductToAnalyticsItem`: `item_id` is `productID` (the SKU), so a site
   *  sending either shape lands the same id in `item_ids`. `sku` is the fallback because the
   *  lighter Product the FARM puts on shelf cards carries `sku` and no `productID`. */
  const productId = (pr: any) => String(pr?.productID ?? pr?.sku ?? "");

  /** Price of one unit off a schema.org `AggregateOffer`. `lowPrice` is the price the shopper
   *  sees; the first offer is the fallback for the trimmed Product on shelf cards. */
  const unitPrice = (pr: any): number | undefined => {
    const o = pr?.offers;
    const v = o?.lowPrice ?? o?.offers?.[0]?.price;
    return typeof v === "number" ? v : undefined;
  };

  /** Events where `value` means money that moved. A `view_item_list` of 40 cards has no value:
   *  summing the shelf would put a number in a revenue column that no shopper ever paid. */
  const VALUED = new Set(["add_to_cart", "remove_from_cart", "begin_checkout", "purchase"]);

  const money = (name: string, p: any) => {
    const items = p?.items ?? p?.ecommerce?.items;
    const products = Array.isArray(items) ? undefined : p?.products;
    const out: Record<string, unknown> = {};
    if (typeof p?.value === "number") out.value = p.value;
    if (typeof p?.currency === "string") out.currency = p.currency;
    if (Array.isArray(items)) {
      out.items_count = items.length;
      out.item_ids = items
        .map((i: any) => String(i?.item_id ?? i?.id ?? ""))
        .filter(Boolean)
        .slice(0, LIMITS.itemIds);
    } else if (Array.isArray(products)) {
      out.items_count = products.length;
      out.item_ids = products.map(productId).filter(Boolean).slice(0, LIMITS.itemIds);
      // Only when the site did not say it, and only on events where a value is money.
      if (out.value === undefined && VALUED.has(name)) {
        let sum = 0;
        let priced = 0;
        for (const pr of products) {
          const u = unitPrice(pr);
          if (u === undefined) continue;
          sum += u * (typeof pr?.quantity === "number" && pr.quantity > 0 ? pr.quantity : 1);
          priced++;
        }
        // All or nothing: a cart of three with one unpriced item is not worth the two we
        // could price, and a partial sum would look exactly like a real one.
        if (priced && priced === products.length) out.value = Math.round(sum * 100) / 100;
      }
      const cur = products[0]?.offers?.priceCurrency;
      if (out.currency === undefined && typeof cur === "string" && out.value !== undefined)
        out.currency = cur;
    }
    if (typeof p?.transaction_id === "string") out.transaction_id = p.transaction_id;
    return out;
  };

  /** Subscribe WHENEVER the bus shows up, not only if it is already there.
   *
   *  This was `window?.DECO?.events?.subscribe?.(…)` — one attempt, optional-chained, no retry —
   *  and it lost every commerce event on a real site. React hoists `<script async>` into `<head>`
   *  regardless of where the component sits in the tree: measured on igor-tanstack.deco.site,
   *  our tag is at byte 200 and the inline block that defines `DECO.events` is at byte 1905, in
   *  the body. So this ran first, found nothing, and never tried again. Two `view_promotion`
   *  events fired and went nowhere, with no error and a page that looked perfectly instrumented.
   *
   *  NOTHING IS LOST BY ARRIVING LATE, which is what makes polling the right answer rather than
   *  a patch: the bus keeps a `_q` and `subscribe` replays it to a new subscriber. So the only
   *  requirement is to subscribe eventually.
   *
   *  Bounded at ten seconds. A page that has not defined the bus by then does not have one —
   *  a site without the deco runtime is a normal thing, and an interval left running forever
   *  would be this module's parting gift to every such page.
   */
  const onBus = (fn: (event: any) => void) => {
    const w = (globalThis as any).window;
    const now = w?.DECO?.events;
    if (typeof now?.subscribe === "function") {
      now.subscribe(fn);
      return;
    }
    let tries = 0;
    const iv = setInterval(() => {
      const bus = (globalThis as any).window?.DECO?.events;
      if (typeof bus?.subscribe === "function") {
        clearInterval(iv);
        bus.subscribe(fn);
        return;
      }
      if (++tries >= 100) clearInterval(iv);
    }, 100);
  };

  onBus((event: any) => {
    if (!event?.name) return;

    // The bus replays a synthetic "deco" event on subscribe, carrying the same flags the
    // cookie already gave us. Ignored rather than mapped: it is not something a visitor
    // did, and turning it into an event would put a row in the table for every page load
    // that means nothing.
    if (event.name === "deco") return;

    const mapped = NAME_MAP[event.name];
    if (!mapped) return; // unknown bus events are not forwarded blind

    const p = event.params ?? {};
    const props: Props = {};
    // The schema.org shape carries the list on the product, not on the event.
    const list = p.item_list_name ?? p.products?.[0]?.item_list_name;
    if (typeof list === "string") props.list = list.slice(0, 200);
    if (typeof p.search_term === "string")
      props.term = p.search_term.trim().toLowerCase().slice(0, 200);

    enqueue(mapped, props, money(event.name, p));
  });
});
