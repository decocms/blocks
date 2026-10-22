import type { Metadata } from "next";
import { openPage, pathnameFor } from "../../../../open-page.server";
import { PageView } from "../../../PageView";

// A published page. The proxy rewrites every CMS page here, to /_assignments/<assignments>/<path>:
// the tests the visitor is in and the campaigns running, never the visitor. The proxy decides, the
// page renders that (assignedClient) and reads no request, so Next caches one entry per path and
// assignments and serves it to every visitor with the same ones. ISR, never force-static: a cached
// page is rendered again in the background on the first request after it is 10 minutes old
// (that request still gets the stored copy), so it is about 10 minutes stale. Drafts
// render on /_draft.
export const revalidate = 600;
// No path is rendered at build time: each is rendered on its first request, then cached (ISR).
export async function generateStaticParams() {
  return [];
}
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
