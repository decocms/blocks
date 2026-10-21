import { Fragment, type ReactNode } from "react";
import type { ResolvedPage } from "../model";
import type { Post } from "../post";

export function PageView({
  post,
  page,
  decisions,
}: {
  post: Post | null;
  page: ResolvedPage<ReactNode> | null;
  /** The decisions route's segment, shown for the smoke. */
  decisions?: string;
}) {
  if (post) {
    return (
      <article data-decisions={decisions}>
        <h1>{post.name}</h1>
        <p>{post.body}</p>
      </article>
    );
  }
  return (
    <main data-decisions={decisions}>
      {page?.sections.map((section, index) => (
        <Fragment key={index}>{section}</Fragment>
      ))}
    </main>
  );
}
