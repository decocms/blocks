import SeoComponent, {
  renderTemplateString,
  type SEOSection,
} from "@decocms/apps-website/components/Seo";
import { type BlogSeoDefaults, getBlogConfig } from "../../client";
import type { BlogPostPage } from "../../types";
import { toBlogPosting, toBreadcrumbList, withCanonicalBase } from "../../utils/jsonLD";

export type Props = {
  /** @title Data Source */
  jsonLD: BlogPostPage | null;
  /** @title Title Override */
  title?: string;
  /** @title Description Override */
  description?: string;
};

/**
 * @title Blog Post details
 *
 * Mirrors `SeoV2`'s contract in `@decocms/apps-website`: the site-level SEO
 * defaults arrive as the third argument when the framework threads them
 * through, and otherwise come from the blog app's own config.
 */
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

  const image = jsonLD?.post?.seo?.image || jsonLD?.seo?.image || jsonLD?.post?.image;
  const { canonicalBaseUrl, publisher } = getBlogConfig();
  const requestUrl = req?.url ?? canonicalBaseUrl ?? "http://localhost/";
  // Configured canonicals may be relative; resolve against the request URL
  const canonical = jsonLD?.seo?.canonical
    ? withCanonicalBase(new URL(jsonLD.seo.canonical, requestUrl).href, canonicalBaseUrl)
    : undefined;
  const noIndexing = !jsonLD || jsonLD.seo?.noIndexing;

  const pageUrl = canonical ?? withCanonicalBase(requestUrl, canonicalBaseUrl);
  const jsonLDs = jsonLD?.post
    ? [
        toBlogPosting(jsonLD.post, pageUrl, publisher),
        toBreadcrumbList(pageUrl, {
          currentName: jsonLD.post.title,
          categories: jsonLD.post.categories,
        }),
      ]
    : [];

  return {
    ...seoSiteProps,
    title,
    description,
    image,
    canonical,
    noIndexing,
    jsonLDs,
  };
}

function Section(props: Props): SEOSection {
  return <SeoComponent {...props} />;
}

export default Section;
