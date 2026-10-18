import type { Metadata } from "next";
import { openPage, pathnameFor } from "../../open-page.server";
import { PageView } from "../PageView";

// A published page: static, rendered once per path and cached. Drafts render on /_draft.
export const dynamic = "force-static";
type Props = { params: Promise<{ path?: string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { post, page } = await openPage(pathnameFor((await params).path));
  if (post) return { title: post.name };
  return { title: page.seo?.title, description: page.seo?.description };
}

export default async function Page({ params }: Props) {
  return <PageView {...await openPage(pathnameFor((await params).path))} />;
}
