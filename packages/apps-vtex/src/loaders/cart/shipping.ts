/**
 * `vtex/loaders/cart/shipping` — shipping options for the drawer.
 *
 * Runs a VTEX cart simulation for the given items + postal code and returns a
 * normalized, de-duplicated list of shipping SLAs (price in major units). This
 * is separate from the cart mutation path so the drawer can show delivery
 * estimates without re-fetching the whole OrderForm.
 *
 * NOTE on caching: shipping options for a fixed {items, postalCode, sc} are not
 * user-personalized, so they are cache-friendly in principle. But the
 * simulation is a POST and `vtexCachedFetch` only caches GET, and `simulateCart`
 * intentionally uses `vtexFetchWithCookies` because the endpoint can rotate
 * segment/ownership cookies. Caching therefore needs a bespoke `fetchWithCache`
 * key that excludes cookies — deferred to a follow-up rather than risk
 * cookie-drift here.
 */

import { type SimulationItem, simulateCart } from "../../actions/checkout";

const CENTS_PER_MAJOR = 100;

export interface CartShippingProps {
  items: SimulationItem[];
  postalCode: string;
  country?: string;
}

export interface ShippingOption {
  id: string;
  name: string;
  /** Price in major units. */
  price: number;
  shippingEstimate: string;
  deliveryChannel?: string;
}

export interface CartShipping {
  postalCode: string;
  options: ShippingOption[];
}

interface SimSla {
  id: string;
  name: string;
  price: number;
  shippingEstimate: string;
  deliveryChannel?: string;
}

export default async function cartShipping(props: CartShippingProps): Promise<CartShipping> {
  const { items, postalCode, country } = props;
  if (!items?.length || !postalCode) return { postalCode, options: [] };

  const sim = await simulateCart({ items, postalCode, country });
  const logisticsInfo: Array<{ slas?: SimSla[] }> = sim?.logisticsInfo ?? [];

  // Collapse SLAs across all items into one unique-by-id option list.
  const byId = new Map<string, ShippingOption>();
  for (const info of logisticsInfo) {
    for (const sla of info.slas ?? []) {
      if (byId.has(sla.id)) continue;
      byId.set(sla.id, {
        id: sla.id,
        name: sla.name,
        price: (sla.price ?? 0) / CENTS_PER_MAJOR,
        shippingEstimate: sla.shippingEstimate,
        deliveryChannel: sla.deliveryChannel,
      });
    }
  }

  return { postalCode, options: [...byId.values()] };
}
