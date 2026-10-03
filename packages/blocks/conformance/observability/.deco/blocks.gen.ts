// A content module as `deco content` writes it, for the docs' cms.ts examples.
const content: {
  revision: string;
  root: string;
  blocks: Record<string, unknown>;
} = {
  revision: "rev-observability",
  root: "conformance/observability/.deco",
  blocks: {
    Analytics: { __resolveType: "analytics" },
    Banner: { __resolveType: "promo-banner", title: "Sale", href: "/sale" },
  },
};

export default content;
