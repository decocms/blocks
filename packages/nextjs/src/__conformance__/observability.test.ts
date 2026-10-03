// @vitest-environment node
/**
 * Conformance: the Next.js half of caching.mdx ("Upstream data": requests go
 * through Next's data cache, no cache of the binding's own) and of
 * telemetry.mdx ("What's sent": the binding reports inbound requests).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInstrumentedFetch } from "@decocms/blocks/fetch";
import { afterEach, describe, expect, it, vi } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sources(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__conformance__" && entry.name !== "__tests__") walk(full);
      } else if (/\.(ts|tsx|cjs|js)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
        out.push({ file: path.relative(SRC, full), text: fs.readFileSync(full, "utf8") });
      }
    }
  };
  walk(SRC);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("upstream data on Next.js (caching.mdx)", () => {
  it("cache-04: the instrumented fetch goes through the fetch Next patches, with Next's cache options intact", async () => {
    const instrumented = createInstrumentedFetch({ provider: "acme-search" });
    // Next replaces globalThis.fetch after modules load; the instrumented fetch must use it.
    const nextFetch = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", nextFetch);
    await instrumented("https://search.example/q", {
      operation: "search",
      next: { revalidate: 60, tags: ["search"] },
    } as RequestInit & { operation: string });
    expect(nextFetch).toHaveBeenCalledTimes(1);
    const init = (nextFetch.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1];
    expect(init.next).toEqual({ revalidate: 60, tags: ["search"] });
  });

  it("cache-04: @decocms/nextjs has no upstream cache of its own", () => {
    const own = sources().filter(({ text }) =>
      /caches\.default|caches\.open|createFetchCache|fetchWithCache/.test(text),
    );
    expect(own.map((s) => s.file)).toEqual([]);
  });
});

describe("what the binding adds (telemetry.mdx › What's sent)", () => {
  it("tel-09: @decocms/nextjs reports inbound requests (http.server.request.duration) to the CMS's telemetry", () => {
    const reporters = sources().filter(({ text }) => text.includes("http.server.request.duration"));
    expect(reporters.map((s) => s.file)).not.toEqual([]);
  });
});
