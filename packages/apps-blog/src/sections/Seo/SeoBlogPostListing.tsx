import SeoComponent, {
  renderTemplateString,
  type SEOSection,
} from "@decocms/apps-website/components/Seo";
import { type BlogSeoDefaults, getBlogConfig } from "../../client";
import type { BlogPostListingPage } from "../../types";
import {
  toBlogPosting,
  toBreadcrumbList,
  toOrganization,
  withCanonicalBase,
} from "../../utils/jsonLD";

export type Props = {
  /** @title Data Source */
  jsonLD: BlogPostListingPage | null;
  /** @title Title Override */
  title?: string;
  /** @title Description Override */
  description?: string;
};

/** @title Blog Post listing */
export function loader(props: Props, req?: Request, seo?: BlogSeoDefaults) {
  const rawSeo: BlogSeoDefaults = seo ?? getBlogConfig().seo ?? {};
  const titleTemplate = typeof rawSeo.titleTemplate === "string" ? rawSeo.titleTemplate : "%s";
  const descriptionTemplate =
    typeof rawSeo.descriptionTemplate === "string" ? rawSeo.descriptionTemplate : "%s";
  const { titleTemplate: _tt, descriptionTemplate: _dt, ...seoSiteProps } = rawSeo;

  const { title: titleProp, description: descriptionProp, jsonLD } = props;

  const title = renderTemplateString(titleTemplate, titleProp || jsonLD?.seo?.title || "");
  const description = renderTemplateString(
    descriptionTemplate,
    descriptionProp || jsonLD?.seo?.description || "",
  );

  const { canonicalBaseUrl, publisher } = getBlogConfig();
  const requestUrl = req?.url ?? canonicalBaseUrl ?? "http://localhost/";
  // Configured canonicals may be relative; resolve against the request URL
  const canonical = jsonLD?.seo?.canonical
    ? withCanonicalBase(new URL(jsonLD.seo.canonical, requestUrl).href, canonicalBaseUrl)
    : undefined;
  const noIndexing = !jsonLD || jsonLD.seo?.noIndexing;

  const url = canonical ?? withCanonicalBase(requestUrl, canonicalBaseUrl);
  const jsonLDs = jsonLD
    ? [
        {
          "@type": "Blog" as const,
          ...(title ? { name: title } : {}),
          ...(description ? { description } : {}),
          url,
          mainEntityOfPage: { "@type": "WebPage" as const, "@id": url },
          ...(publisher?.name ? { publisher: toOrganization(publisher) } : {}),
          blogPost: jsonLD.posts?.map((post) => toBlogPosting(post)) ?? [],
        },
        toBreadcrumbList(url, {
          currentName: jsonLD.category?.name || title || undefined,
          categories: jsonLD.categories ?? undefined,
        }),
      ]
    : [];

  return {
    ...seoSiteProps,
    title,
    description,
    canonical,
    noIndexing,
    jsonLDs,
  };
}

function Section(props: Props): SEOSection {
  return <SeoComponent {...props} />;
}

export default Section;
