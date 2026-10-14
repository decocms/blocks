/** Test doubles: a CMS over an in-memory release, with the `CMS` block's preview hosts when given. */
import { type Blocks, type CMS, createCMS, type Snapshot } from "@decocms/blocks";

/** A pointer that parses (Studio's draft API on a decocms.com host). */
export const POINTER = "studio.decocms.com/api/acme/decofile/mcp/main?token=t@v1";

/** A release with a page and, when given, the `CMS` block's preview hosts. */
export function snapshot(options: { previewHosts?: string[] } = {}): Snapshot {
  const blocks: Record<string, unknown> = {
    Home: { __resolveType: "page", path: "/", sections: [] },
  };
  if (options.previewHosts) {
    blocks.CMS = { __resolveType: "cms-settings", preview: { hosts: options.previewHosts } };
  }
  return { revision: "rev-1", blocks } as Snapshot;
}

let count = 0;

/** A CMS of its own (a fresh content root) over `content`. */
// By default the test store declares its own host, so a draft on shop.example.com previews.
export function testCMS(content: Snapshot = snapshot({ previewHosts: ["shop.example.com"] })): CMS {
  count += 1;
  return createCMS({
    blocks: {} as Blocks,
    content: { ...content, root: `/nextjs-test-cms-${count}` } as Snapshot & { root: string },
  });
}
