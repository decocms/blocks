import { Fragment, type ReactNode } from "react";
import type { ResolvedPage } from "../model";
import type { Post } from "../post";

export function PageView({
  post,
  page,
  assignments,
}: {
  post: Post | null;
  page: ResolvedPage<ReactNode> | null;
  /** The assignments route's segment, shown for the smoke. */
  assignments?: string;
}) {
  if (post) {
    return (
      <article data-assignments={assignments}>
        <h1>{post.name}</h1>
        <p>{post.body}</p>
      </article>
    );
  }
  return (
    <main data-assignments={assignments}>
      {page?.sections.map((section, index) => (
        <Fragment key={index}>{section}</Fragment>
      ))}
    </main>
  );
}
