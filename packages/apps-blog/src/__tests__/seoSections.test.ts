/**
 * Scope: the JSON-LD and canonical output of the two SEO section loaders, plus
 * the `utils/jsonLD.ts` mappers they delegate to. These are the whole reason
 * the SEO sections exist, and none of it was reachable in this package before.
 *
 * Deliberately not covered: rendering the `Seo` component itself (that lives in
 * `@decocms/apps-website`), and the schema/admin wiring.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { configureBlog } from "../client";
import { loader as seoPostLoader } from "../sections/Seo/SeoBlogPost";
import { loader as seoListingLoader } from "../sections/Seo/SeoBlogPostListing";
import type { BlogPost, BlogPostListingPage, BlogPostPage } from "../types";
import { toBlogPosting, toBreadcrumbList, withCanonicalBase } from "../utils/jsonLD";

const post = (overrides: Partial<BlogPost> = {}): BlogPost => ({
  title: "How to brew",
  slug: "how-to-brew",
  date: "2024-06-01",
  excerpt: "A guide",
  ...overrides,
});

const page = (p: BlogPost): BlogPostPage => ({
  "@type": "BlogPostPage",
  post: p,
  seo: { title: p.title, description: p.excerpt },
});

const req = (url = "https://shop.example/blog/coffee/how-to-brew?utm=x") => new Request(url);

const nodesOf = (result: { jsonLDs?: unknown[] }) => (result.jsonLDs ?? []) as any[];

beforeEach(() => {
  configureBlog({});
});

describe("withCanonicalBase", () => {
  it("strips query and hash, keeping origin + pathname", () => {
    expect(withCanonicalBase("https://a.com/blog/x?q=1#frag")).toBe("https://a.com/blog/x");
  });

  it("swaps the origin for the configured canonical base", () => {
    expect(withCanonicalBase("https://preview.a.com/blog/x?q=1", "https://www.a.com")).toBe(
      "https://www.a.com/blog/x",
    );
  });

  it("returns an unparseable relative URL unchanged when no base is configured", () => {
    expect(withCanonicalBase("/blog/x")).toBe("/blog/x");
  });
});

describe("toBlogPosting", () => {
  it("emits the required BlogPosting fields", () => {
    const node = toBlogPosting(post({ dateModified: "2024-07-01" }), "https://a.com/blog/x");
    expect(node["@type"]).toBe("BlogPosting");
    expect(node.headline).toBe("How to brew");
    expect(node.datePublished).toBe("2024-06-01");
    expect(node.dateModified).toBe("2024-07-01");
    expect(node.mainEntityOfPage).toEqual({ "@type": "WebPage", "@id": "https://a.com/blog/x" });
  });

  it("omits `@context` — the Seo component adds it when serializing", () => {
    expect("@context" in toBlogPosting(post())).toBe(false);
  });

  it("maps authors, defaulting the type to Person and scoping Person-only props", () => {
    const node = toBlogPosting(
      post({
        authors: [
          { name: "Ana", email: "a@b.com", jobTitle: "Barista", company: "Cafe" },
          { name: "Acme", email: "c@d.com", type: "Organization", jobTitle: "ignored" },
        ],
      }),
    );
    expect(node.author).toEqual([
      {
        "@type": "Person",
        name: "Ana",
        jobTitle: "Barista",
        worksFor: { "@type": "Organization", name: "Cafe" },
      },
      { "@type": "Organization", name: "Acme" },
    ]);
  });

  it("emits the publisher as an Organization when configured", () => {
    const node = toBlogPosting(post(), undefined, {
      name: "Acme",
      url: "https://a.com",
      logo: "logo.png",
    });
    expect(node.publisher).toEqual({
      "@type": "Organization",
      name: "Acme",
      url: "https://a.com",
      logo: { "@type": "ImageObject", url: "logo.png" },
    });
  });

  it("drops an aggregateRating stub that would fail the Rich Results Test", () => {
    // ratingValue present but no count → invalid; and a bare @type stub → invalid.
    expect(
      toBlogPosting(post({ aggregateRating: { "@type": "AggregateRating" } })).aggregateRating,
    ).toBeUndefined();
    expect(
      toBlogPosting(post({ aggregateRating: { "@type": "AggregateRating", ratingValue: 4 } }))
        .aggregateRating,
    ).toBeUndefined();
    expect(
      toBlogPosting(
        post({ aggregateRating: { "@type": "AggregateRating", ratingValue: 4, ratingCount: 2 } }),
      ).aggregateRating,
    ).toEqual({ "@type": "AggregateRating", ratingValue: 4, ratingCount: 2 });
  });

  it("emits timeRequired only for a finite positive readTime", () => {
    expect(toBlogPosting(post({ readTime: 7 })).timeRequired).toBe("PT7M");
    expect(toBlogPosting(post({ readTime: 0 })).timeRequired).toBeUndefined();
    expect(
      toBlogPosting(post({ readTime: Number.POSITIVE_INFINITY })).timeRequired,
    ).toBeUndefined();
  });
});

describe("toBreadcrumbList", () => {
  it("names segments from known categories and humanizes the rest", () => {
    const node = toBreadcrumbList("https://a.com/blog/cold-brew/my-post", {
      currentName: "My Post",
      categories: [{ name: "Cold Brew Coffee", slug: "cold-brew" }],
    });
    expect(node.itemListElement).toEqual([
      { "@type": "ListItem", position: 1, name: "Blog", item: "https://a.com/blog" },
      {
        "@type": "ListItem",
        position: 2,
        name: "Cold Brew Coffee",
        item: "https://a.com/blog/cold-brew",
      },
      { "@type": "ListItem", position: 3, name: "My Post" },
    ]);
  });

  it("omits `item` on the last entry, as Google allows", () => {
    const node = toBreadcrumbList("https://a.com/blog/x", { currentName: "X" });
    expect("item" in node.itemListElement[node.itemListElement.length - 1]).toBe(false);
  });
});

describe("SeoBlogPost loader", () => {
  it("emits BlogPosting + BreadcrumbList against the request URL", () => {
    const result = seoPostLoader({ jsonLD: page(post()) }, req());
    const [posting, breadcrumb] = nodesOf(result);
    expect(posting["@type"]).toBe("BlogPosting");
    expect(breadcrumb["@type"]).toBe("BreadcrumbList");
    // Query string stripped for both canonical and JSON-LD.
    expect(posting.url).toBe("https://shop.example/blog/coffee/how-to-brew");
  });

  it("rewrites the JSON-LD origin to the configured canonical base", () => {
    configureBlog({ canonicalBaseUrl: "https://www.example.com" });
    const [posting] = nodesOf(seoPostLoader({ jsonLD: page(post()) }, req()));
    expect(posting.url).toBe("https://www.example.com/blog/coffee/how-to-brew");
  });

  it("includes the configured publisher", () => {
    configureBlog({ publisher: { name: "Acme" } });
    const [posting] = nodesOf(seoPostLoader({ jsonLD: page(post()) }, req()));
    expect(posting.publisher).toEqual({ "@type": "Organization", name: "Acme" });
  });

  it("applies the site title/description templates", () => {
    configureBlog({ seo: { titleTemplate: "%s | Acme", descriptionTemplate: "%s — read more" } });
    const result = seoPostLoader({ jsonLD: page(post()) }, req());
    expect(result.title).toBe("How to brew | Acme");
    expect(result.description).toBe("A guide — read more");
  });

  it("prefers explicit overrides over the post's own seo", () => {
    const result = seoPostLoader(
      { jsonLD: page(post()), title: "Override", description: "Desc override" },
      req(),
    );
    expect(result.title).toBe("Override");
    expect(result.description).toBe("Desc override");
  });

  it("resolves a relative configured canonical against the request URL", () => {
    const result = seoPostLoader(
      { jsonLD: { ...page(post()), seo: { canonical: "/blog/canonical-path" } } },
      req(),
    );
    expect(result.canonical).toBe("https://shop.example/blog/canonical-path");
  });

  it("noIndexes a null data source and emits no JSON-LD", () => {
    const result = seoPostLoader({ jsonLD: null }, req());
    expect(result.noIndexing).toBe(true);
    expect(result.jsonLDs).toEqual([]);
  });

  it("propagates the post's own noIndexing — the draft-preview path", () => {
    const result = seoPostLoader({ jsonLD: { ...page(post()), seo: { noIndexing: true } } }, req());
    expect(result.noIndexing).toBe(true);
  });
});

describe("SeoBlogPostListing loader", () => {
  const listing = (overrides: Partial<BlogPostListingPage> = {}): BlogPostListingPage => ({
    posts: [post({ slug: "a", title: "A" }), post({ slug: "b", title: "B" })],
    pageInfo: { currentPage: 1, nextPage: undefined, previousPage: undefined },
    seo: { title: "Coffee" },
    ...overrides,
  });

  it("emits a Blog node listing every post, plus a BreadcrumbList", () => {
    const [blog, breadcrumb] = nodesOf(
      seoListingLoader({ jsonLD: listing() }, req("https://shop.example/blog/coffee")),
    );
    expect(blog["@type"]).toBe("Blog");
    expect(blog.name).toBe("Coffee");
    expect(blog.blogPost.map((p: { headline: string }) => p.headline)).toEqual(["A", "B"]);
    expect(blog.mainEntityOfPage["@id"]).toBe("https://shop.example/blog/coffee");
    expect(breadcrumb["@type"]).toBe("BreadcrumbList");
  });

  it("names the breadcrumb leaf after the active category", () => {
    const [, breadcrumb] = nodesOf(
      seoListingLoader(
        { jsonLD: listing({ category: { name: "Cold Brew", slug: "cold-brew" } }) },
        req("https://shop.example/blog/cold-brew"),
      ),
    );
    const leaf = breadcrumb.itemListElement.at(-1);
    expect(leaf.name).toBe("Cold Brew");
  });

  it("noIndexes a null data source", () => {
    const result = seoListingLoader({ jsonLD: null }, req());
    expect(result.noIndexing).toBe(true);
    expect(result.jsonLDs).toEqual([]);
  });
});
