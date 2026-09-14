import { describe, expect, it } from "vitest";
import { createReplaceStream } from "./abTesting";

/**
 * The A/B fallback proxy used to buffer the whole upstream body into a JS
 * string (two bytes per character) plus the replaced copy, just to swap a
 * hostname — megabytes of a 128MB isolate budget. This streams it instead,
 * which is only correct if two hazards are handled: a match straddling a chunk
 * boundary, and a multi-byte character split across chunks.
 */

const enc = new TextEncoder();

/** Push `chunks` through the transform and read the whole output back. */
async function run(search: string, replace: string, chunks: string[] | Uint8Array[]) {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(typeof c === "string" ? enc.encode(c) : c);
      }
      controller.close();
    },
  });
  const out = source.pipeThrough(createReplaceStream(search, replace));
  return await new Response(out).text();
}

describe("createReplaceStream", () => {
  it("replaces within a single chunk", async () => {
    await expect(run("old.site", "new.site", ["go to old.site now"])).resolves.toBe(
      "go to new.site now",
    );
  });

  it("replaces every occurrence, not just the first", async () => {
    await expect(run("a", "X", ["banana"])).resolves.toBe("bXnXnX");
  });

  it("replaces a match split across a chunk boundary", async () => {
    // The hazard the hold-back exists for.
    await expect(run("old.site", "new.site", ["go to old.", "site now"])).resolves.toBe(
      "go to new.site now",
    );
  });

  it("replaces a match split one character at a time", async () => {
    await expect(run("abc", "X", [..."1abc2"])).resolves.toBe("1X2");
  });

  it("does not re-replace when the replacement ends in a prefix of the search", async () => {
    // Held-back text is taken from the RAW input, never from replaced output.
    // Otherwise "abc"->"xab" would leave "ab", join the next chunk's "c", and
    // be replaced a second time.
    await expect(run("abc", "xab", ["abc", "c"])).resolves.toBe("xabc");
  });

  it("carries a multi-byte character split across chunks", async () => {
    // "ã" is two bytes in UTF-8 — split them.
    const bytes = enc.encode("promoção");
    const mid = bytes.indexOf(0xc3); // first byte of "ç"
    const out = await run("x", "y", [bytes.slice(0, mid + 1), bytes.slice(mid + 1)]);
    expect(out).toBe("promoção");
  });

  it("passes a body through untouched when nothing matches", async () => {
    await expect(run("nope", "!", ["hello ", "world"])).resolves.toBe("hello world");
  });

  it("handles an empty body", async () => {
    await expect(run("a", "b", [])).resolves.toBe("");
  });

  it("handles a match at the very end of the stream", async () => {
    // Lands entirely in the held-back tail, so only `flush` can emit it.
    await expect(run("end", "END", ["the ", "end"])).resolves.toBe("the END");
  });

  it("handles a match at the very start", async () => {
    await expect(run("go", "GO", ["go home"])).resolves.toBe("GO home");
  });

  it("holds back at most search.length - 1 characters", async () => {
    // Peak memory must be one chunk plus a bounded tail, never the body.
    const big = "z".repeat(10_000);
    await expect(run("old.site", "new.site", [big, "old.site", big])).resolves.toBe(
      `${big}new.site${big}`,
    );
  });
});
