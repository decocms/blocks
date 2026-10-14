import { Fragment, type ReactNode } from "react";
import type { ResolvedPage } from "../model";
import type { Post } from "../post";

export function PageView({ post, page }: { post: Post | null; page: ResolvedPage<ReactNode> | null }) {
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
      {page?.sections.map((section, index) => (
        <Fragment key={index}>{section}</Fragment>
      ))}
    </main>
  );
}
