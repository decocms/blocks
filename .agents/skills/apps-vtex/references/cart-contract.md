# Contract — projections and section presets (`@decocms/apps-commerce`)

```ts
import type { CartProjection, CartSection, CartSummary, CartSummaryWithItems, CartOk, CartItemSlim } from "@decocms/apps-commerce/types/cart";
import { SECTIONS_MINIMAL, SECTIONS_DRAWER, SECTIONS_FULL, defaultSectionsFor } from "@decocms/apps-commerce/types/cart";
```

### `CartProjection`

| Value | What goes to the browser | When to use |
|---|---|---|
| `"none"` | `{ ok: true }` | Pure optimistic update, zero reconciliation data needed |
| `"summary"` | `{ orderFormId, totalItems, total }` | Badge-only refresh |
| `"summary+items"` | summary + slim line items | **Default for add-to-cart** |
| `"minicart"` | Full canonical `Minicart` | Opening the drawer |
| `"raw"` | Untouched VTEX OrderForm | GTM, pixels, custom integrations |

### `CartSection` presets

| Preset | Sections | Use |
|---|---|---|
| `SECTIONS_MINIMAL` | `items, totalizers, messages` | All mutations by default |
| `SECTIONS_DRAWER` | 9 sections (+ sellers, marketing, shipping…) | `cart/full` loader |
| `SECTIONS_FULL` | All 15 | Legacy parity / `projection: "raw"` |

`defaultSectionsFor(projection)` returns the right preset if you don't specify sections explicitly.

### Choosing the projection

The projection is a latency-vs-data trade-off. Pick the cheapest one that carries what the UI actually renders — the whole point is not shipping data you won't use.

| I want to… | `projection` | Why |
|---|---|---|
| Just update the badge number | `"summary"` | Smallest payload that still carries the count |
| Show a toast "added: `<product>`" | `"summary+items"` *(default)* | Slim item (name/image/price/variant) already comes back from `add()` — no second fetch |
| Open the drawer right after add | `"minicart"` | Populates the drawer from the same response — avoids a follow-up `cart/full` round-trip |
| 100% optimistic UI, no confirmation | `"none"` | Discards the payload server-side; zero reconciliation |
| Feed GTM / a pixel / a custom integration | `"raw"` | Untouched OrderForm — you map it yourself |

Rule of thumb: **badge → `summary`, toast → `summary+items`, drawer → `minicart`.** Only reach for `raw` when a third-party integration needs the native VTEX shape.
