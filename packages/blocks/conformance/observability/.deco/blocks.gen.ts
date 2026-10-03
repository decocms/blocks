// A content module as `deco content` writes it, for the docs' cms.ts examples.
import type { Snapshot } from "@decocms/blocks";

const content: Snapshot = {
  revision: "rev-observability",
  root: "conformance/observability/.deco",
  blocks: {
    Analytics: { __resolveType: "analytics" },
    Banner: { __resolveType: "promo-banner", title: "Sale", href: "/sale" },
  },
};

export default content;
