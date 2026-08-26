import { getSyncComponent } from "@decocms/blocks/cms/client";
import { getBlogConfig } from "../client";
import { CSS } from "../static/css";
import type { BlogPost, Section } from "../types";

export type Props = {
  post: BlogPost | null;
};

const iframeStyle: React.CSSProperties = {
  width: "100%",
  border: "none",
  height: "100vh",
};

/**
 * Renders one CMS-authored section reference (`{ __resolveType, ...props }`).
 *
 * The Deno app used `renderSection` from `website/pages/Page.tsx`; here the
 * equivalent is the section registry's synchronous component lookup. An
 * unregistered `__resolveType` renders nothing rather than throwing — this is a
 * preview surface, and a single unknown section should not blank the whole post.
 */
function renderSection(section: Section, index: number) {
  const resolveType: string | undefined = section?.__resolveType;
  if (!resolveType) return null;

  const Component =
    getSyncComponent(resolveType) ?? getSyncComponent(resolveType.replace(/\.tsx?$/, ""));
  if (!Component) return null;

  const { __resolveType: _drop, ...props } = section;
  return <Component key={`${resolveType}-${index}`} {...props} />;
}

/**
 * CMS preview for a single blog post record.
 *
 * When the app is configured with a `pageSlug`/`categorySlug` route pattern the
 * preview delegates to the real site route in an iframe, so what the editor sees
 * is the actual page. Without one it falls back to rendering the record itself.
 */
export default function Template({ post }: Props) {
  if (!post) return null;

  const { pageSlug, categorySlug } = getBlogConfig();

  const {
    title = "Title",
    content = "Content",
    excerpt = "Excerpt",
    date,
    image,
    alt,
    sections,
    slug,
    categories,
  } = post;

  const postCategorySlug = categories?.[0]?.slug ?? "";

  if (pageSlug) {
    const resolvedUrl = pageSlug.replace(":category", postCategorySlug).replace(":slug", slug);

    return <iframe src={resolvedUrl} style={iframeStyle} title={title} />;
  }

  if (categorySlug) {
    const resolvedUrl = categorySlug.replace(":category", postCategorySlug);

    return <iframe src={resolvedUrl} style={iframeStyle} title={title} />;
  }

  return (
    <>
      <link href="/styles.css" rel="stylesheet" />
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <div className="deco-post-preview">
        <h1>{title}</h1>
        <p className="text-xl">{excerpt}</p>
        <p>
          {date
            ? new Date(`${date}T00:00:00`).toLocaleDateString("en-US", {
                month: "long",
                day: "numeric",
                year: "numeric",
              })
            : ""}
        </p>
        {image && <img className="w-full rounded-2xl bg-cover" src={image} alt={alt ?? title} />}
        <div dangerouslySetInnerHTML={{ __html: content as string }} />
        <div className="content-sections">{sections?.map(renderSection)}</div>
      </div>
    </>
  );
}
