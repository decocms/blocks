import type { Metadata } from "next";
import { openPage, pathnameFor } from "../../../../open-page.server";
import { PageView } from "../../../PageView";

// A published page. The proxy rewrites every CMS page here, to /_assignments/<assignments>/<path>:
// the tests the visitor is in and the campaigns running, never the visitor. Static, so Next renders
// one entry per path and assignments and serves it to every visitor with the same ones; the page
// shows the tests its path names (assignedClient) and checks the campaigns at render time. Drafts
// render on /_draft.
export const dynamic = "force-static";
type Props = { params: Promise<{ assignments: string; path?: string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { assignments, path } = await params;
  const { post, page } = await openPage(pathnameFor(path), assignments);
  if (post) return { title: post.name };
  return { title: page.seo?.title, description: page.seo?.description };
}

export default async function Page({ params }: Props) {
  const { assignments, path } = await params;
  return <PageView {...await openPage(pathnameFor(path), assignments)} assignments={assignments} />;
}
