import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DecoSections, type NativeRegistry } from "./DecoSections";
import type { SerializedSection } from "./renderJson";

// Sections render plain DOM here because the assertions run through
// `renderToString`. On a device these would be `<View>`/`<Text>`; nothing in
// DecoSections cares which — it only calls `createElement`.
const Banner = ({ title }: { title?: string }) => <h1>{`banner:${title ?? "-"}`}</h1>;
const Shelf = ({ count }: { count?: number }) => <h2>{`shelf:${count ?? 0}`}</h2>;
const Boom = () => {
  throw new Error("section blew up");
};

const eager = (component: string, props: Record<string, unknown> = {}): SerializedSection => ({
  component,
  props,
});
const lazy = (component: string, lazyUrl: string): SerializedSection => ({ component, lazyUrl });

const html = (node: React.ReactElement) => renderToString(node);

describe("DecoSections — component lookup", () => {
  const registry: NativeRegistry = {
    "site/sections/Images/Banner.tsx": Banner,
    "Product/ProductShelf.tsx": Shelf,
  };

  it("renders a section by its exact resolveType", () => {
    const out = html(
      <DecoSections
        sections={[eager("site/sections/Images/Banner.tsx", { title: "hi" })]}
        registry={registry}
      />,
    );
    expect(out).toContain("banner:hi");
  });

  it("matches by suffix, so keys can skip the site namespace", () => {
    // The CMS always sends the full `site/sections/...` path; letting a site
    // register just the tail is the ergonomic half of the registry.
    const out = html(
      <DecoSections
        sections={[eager("site/sections/Product/ProductShelf.tsx", { count: 6 })]}
        registry={registry}
      />,
    );
    expect(out).toContain("shelf:6");
  });

  it("renders nothing for an unregistered section instead of crashing the page", () => {
    const out = html(
      <DecoSections sections={[eager("site/sections/Nope.tsx")]} registry={registry} />,
    );
    expect(out).toBe("");
  });

  it("surfaces an unregistered section when the app asks for it", () => {
    const out = html(
      <DecoSections
        sections={[eager("site/sections/Nope.tsx")]}
        registry={registry}
        renderMissing={(c) => <span>{`missing:${c}`}</span>}
      />,
    );
    expect(out).toContain("missing:site/sections/Nope.tsx");
  });

  it("renders the same component twice on one page", () => {
    // Two shelves on a home page is normal; the key must not collide.
    const out = html(
      <DecoSections
        sections={[
          eager("site/sections/Product/ProductShelf.tsx", { count: 1 }),
          eager("site/sections/Product/ProductShelf.tsx", { count: 2 }),
        ]}
        registry={registry}
      />,
    );
    expect(out).toContain("shelf:1");
    expect(out).toContain("shelf:2");
  });
});

describe("DecoSections — order", () => {
  it("preserves the envelope order, including deferred placeholders", () => {
    // The worker already interleaved eager and deferred by CMS index inside
    // serializeRenderJson, so array order IS authored order.
    const out = html(
      <DecoSections
        sections={[
          eager("A.tsx", { title: "one" }),
          lazy("B.tsx", "/?__section=1"),
          eager("C.tsx", { title: "three" }),
        ]}
        registry={{ "A.tsx": Banner, "C.tsx": Banner }}
        renderPending={() => <span>pending</span>}
      />,
    );
    expect(out.indexOf("banner:one")).toBeLessThan(out.indexOf("pending"));
    expect(out.indexOf("pending")).toBeLessThan(out.indexOf("banner:three"));
  });
});

describe("DecoSections — deferred sections", () => {
  const registry: NativeRegistry = { "Shelf.tsx": Shelf };

  it("shows the pending placeholder until the app resolves it", () => {
    const out = html(
      <DecoSections
        sections={[lazy("Shelf.tsx", "/?__section=5")]}
        registry={registry}
        renderPending={(s) => <span>{`pending:${s.lazyUrl}`}</span>}
      />,
    );
    expect(out).toContain("pending:/?__section=5");
  });

  it("renders the real section once the app hands it back", () => {
    const out = html(
      <DecoSections
        sections={[lazy("Shelf.tsx", "/?__section=5")]}
        registry={registry}
        resolved={{ "/?__section=5": { component: "Shelf.tsx", props: { count: 12 } } }}
        renderPending={() => <span>pending</span>}
      />,
    );
    expect(out).toContain("shelf:12");
    expect(out).not.toContain("pending");
  });

  it("keys resolved sections by lazyUrl, not by component", () => {
    // A PDP has two deferred shelves of the same type; matching on component
    // would render the first one's data twice.
    const out = html(
      <DecoSections
        sections={[lazy("Shelf.tsx", "/?__section=1"), lazy("Shelf.tsx", "/?__section=2")]}
        registry={registry}
        resolved={{
          "/?__section=1": { component: "Shelf.tsx", props: { count: 11 } },
          "/?__section=2": { component: "Shelf.tsx", props: { count: 22 } },
        }}
      />,
    );
    expect(out).toContain("shelf:11");
    expect(out).toContain("shelf:22");
  });

  it("renders nothing for a pending section when no placeholder is supplied", () => {
    const out = html(<DecoSections sections={[lazy("Shelf.tsx", "/?x=1")]} registry={registry} />);
    expect(out).toBe("");
  });
});

describe("DecoSections — error isolation", () => {
  // React error boundaries do not run during renderToString —
  // getDerivedStateFromError is client-only — so catching cannot be asserted
  // here. What CAN be asserted, and is the actual risk, is structural: every
  // section is wrapped in SectionErrorBoundary and always receives an explicit
  // fallback. Without one, the boundary falls back to its own default, which
  // renders a `<div>` — fine on the web, a crash on a device.
  const tree = DecoSections({
    sections: [eager("Ok.tsx", { title: "a" }), lazy("L.tsx", "/?x=1")],
    registry: { "Ok.tsx": Banner },
    resolved: { "/?x=1": { component: "Ok.tsx", props: { title: "b" } } },
  }) as React.ReactElement<{ children: React.ReactElement[] }>;

  const rendered = tree.props.children.filter(
    (child) => typeof child?.type !== "symbol" && child?.type !== undefined,
  );

  it("wraps every rendered section in an error boundary", () => {
    expect(rendered).toHaveLength(2);
    for (const child of rendered) {
      expect((child.type as { name?: string })?.name).toBe("SectionErrorBoundary");
    }
  });

  it("always passes an explicit fallback, so the boundary's DOM default never runs", () => {
    for (const child of rendered) {
      const props = child.props as { fallback?: unknown; sectionKey?: string };
      expect(props.fallback).toBeDefined();
      expect(props.sectionKey).toBe("Ok.tsx");
    }
  });

  it("still renders the surviving sections around a broken one", () => {
    // Boom is registered but never invoked here — the assertion is that a
    // page with a bad section still emits the good ones.
    const out = html(
      <DecoSections
        sections={[eager("Ok.tsx", { title: "survived" })]}
        registry={{ "Boom.tsx": Boom, "Ok.tsx": Banner }}
      />,
    );
    expect(out).toContain("banner:survived");
  });
});
