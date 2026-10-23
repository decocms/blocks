/** Test doubles: a CMS over an in-memory release, with the preview hosts Studio writes into it when given. */
import { type Blocks, type CMS, createCMS, type Snapshot } from "@decocms/blocks";
import { vi } from "vitest";

/** A pointer that parses (Studio's draft API on a decocms.com host). */
export const POINTER = "studio.decocms.com/api/acme/decofile/mcp/main?token=t@v1";
/** A pointer to a draft Studio no longer has (its host answers 404). */
export const GONE_POINTER = "studio.decocms.com/api/acme/decofile/mcp/gone?token=t@v1";

/** Stands in for the drafts' host: {@link POINTER}'s changes (empty), a 404 for any other draft. */
export function serveDrafts(): void {
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host === "studio.decocms.com" && url.pathname === "/api/acme/decofile/mcp/main") {
      return Response.json({ set: {}, delete: [] }, { headers: { etag: '"etag-1"' } });
    }
    return new Response("not found", { status: 404 });
  });
}

/**
 * A release with a page, a block that varies on the `buy-button` test and,
 * when given, its preview hosts (release metadata) and the saved `experiments` block.
 */
export function snapshot(
  options: {
    previewHosts?: string[];
    experiments?: Record<string, number>;
    campaigns?: Record<string, { start?: string; end?: string }>;
  } = {},
): Snapshot {
  const blocks: Record<string, unknown> = {
    Home: { __resolveType: "page", path: "/", sections: [] },
    BuyButton: {
      __resolveType: "multivariate",
      variants: [
        { rule: { __resolveType: "experiment", name: "buy-button" }, value: "new" },
        { rule: { __resolveType: "always" }, value: "old" },
      ],
    },
  };
  if (options.experiments) {
    blocks.experiments = { __resolveType: "split-traffic", ...options.experiments };
  }
  if (options.campaigns) {
    blocks.campaigns = { __resolveType: "calendar", ...options.campaigns };
  }
  const release = { revision: "rev-1", blocks } as Snapshot;
  if (options.previewHosts) release.previewHosts = options.previewHosts;
  return release;
}

let count = 0;

/** A CMS of its own (a fresh content root) over `content`. */
// By default Studio lists the test store's host in the release, so a draft on shop.example.com previews.
export function testCMS(content: Snapshot = snapshot({ previewHosts: ["shop.example.com"] })): CMS {
  count += 1;
  return createCMS({
    blocks: {} as Blocks,
    content: { ...content, root: `/nextjs-test-cms-${count}` } as Snapshot & { root: string },
  });
}
