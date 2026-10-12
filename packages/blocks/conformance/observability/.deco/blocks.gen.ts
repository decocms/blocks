// A content module as `deco content` writes it, for the docs' cms.ts examples.
const content: {
  revision: string;
  root: string;
  blocks: Record<string, unknown>;
} = {
  revision: "rev-observability",
  root: "conformance/observability/.deco",
  blocks: {
    CMS: { __resolveType: "cms-settings", analytics: {} },
    Banner: { __resolveType: "promo-banner", title: "Sale", href: "/sale" },
  },
};

export default content;
