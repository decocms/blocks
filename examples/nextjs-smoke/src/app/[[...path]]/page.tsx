import { Fragment } from "react";
import type { Metadata } from "next";
import { openPage, pathnameFor } from "../../open-page.server";

type Props = { params: Promise<{ path?: string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { post, page } = await openPage(pathnameFor((await params).path));
  if (post) return { title: post.name };
  return { title: page.seo?.title, description: page.seo?.description };   // without seo, the layout's metadata applies
}

export default async function Page({ params }: Props) {
  const { post, page } = await openPage(pathnameFor((await params).path));
  if (post) {
    return (
      <article>
        <h1>{post.name}</h1>
        <p>{post.body}</p>
      </article>
    );
  }
  return (
    <main>
      {page.sections.map((section, index) => (
        <Fragment key={index}>{section}</Fragment>
      ))}
    </main>
  );
}
