// analytics.mdx › Send your own events, verbatim inside a component.
import { track } from "@decocms/blocks/analytics";

declare function addToCart(sku: string): void;

export const AddToCart = ({ sku }: { sku: string }) => (
  <button onClick={() => { addToCart(sku); track("add_to_cart", { sku }); }}>Add to cart</button>
);
