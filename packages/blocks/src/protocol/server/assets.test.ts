// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isAcceptedAssetType, sanitizeAssetName, suffixedAssetName } from "../assets";
import { ErrorCode } from "../errors";
import { createMemoryStorage, type MemoryStorageOptions } from "../storage/memory";
import { createAssetHandler } from "./assets";

function setup(options: MemoryStorageOptions = {}, token?: string) {
  const storage = createMemoryStorage(options);
  return { storage, handler: createAssetHandler(storage, { token }) };
}

const put = (
  name: string,
  body: BodyInit,
  type = "image/jpeg",
  headers: Record<string, string> = {},
) =>
  new Request(`http://127.0.0.1:4545/assets/${name}`, {
    method: "PUT",
    headers: { "content-type": type, ...headers },
    body,
  });

describe("PUT /assets/<name>", () => {
  it("stores the file and answers with the path the site editor saves: /assets/<name>", async () => {
    const { handler, storage } = setup();
    const response = await handler(put("summer-banner.jpg", new Uint8Array([1, 2, 3])));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ path: "/assets/summer-banner.jpg" });
    expect(Object.keys(storage.dump().assets)).toEqual(["summer-banner.jpg"]);
  });

  it("never overwrites an existing file: a taken name gets a short suffix", async () => {
    const { handler } = setup();
    await handler(put("a.png", new Uint8Array([1]), "image/png"));
    const second = (await (
      await handler(put("a.png", new Uint8Array([2]), "image/png"))
    ).json()) as { path: string };
    expect(second.path).toMatch(/^\/assets\/a-[0-9a-f]{6}\.png$/);
  });

  it.each([
    "image/webp",
    "image/svg+xml",
    "video/mp4",
    "font/woff2",
    "application/pdf",
  ])("accepts %s", async (type) => {
    const { handler } = setup();
    expect((await handler(put("f.bin", new Uint8Array([1]), type))).status).toBe(201);
  });

  it.each([
    "application/json",
    "text/html",
    "application/x-www-form-urlencoded",
    "",
  ])("refuses %j with HTTP 415", async (type) => {
    const { handler } = setup();
    expect((await handler(put("f.bin", new Uint8Array([1]), type))).status).toBe(415);
  });

  it("checks the same bearer token as the protocol", async () => {
    const { handler } = setup({}, "tok");
    expect((await handler(put("a.png", new Uint8Array([1])))).status).toBe(401);
    expect(
      (
        await handler(
          put("a.png", new Uint8Array([1]), "image/png", { authorization: "Bearer tok" }),
        )
      ).status,
    ).toBe(201);
  });

  it("refuses uploads over the advertised size with HTTP 413", async () => {
    const { handler } = setup({ description: { assets: { dir: "public/assets", maxBytes: 4 } } });
    const response = await handler(put("a.png", new Uint8Array(5)));
    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: { code: number } }).error.code).toBe(
      ErrorCode.LimitExceeded,
    );
  });

  it("refuses uploads on a read-only endpoint or one without an asset folder", async () => {
    expect(
      (await setup({ description: { readOnly: true } }).handler(put("a.png", "x"))).status,
    ).toBe(403);
    expect((await setup({ description: { assets: null } }).handler(put("a.png", "x"))).status).toBe(
      404,
    );
  });

  it("refuses other methods, empty bodies and missing names", async () => {
    const { handler } = setup();
    expect(
      (await handler(new Request("http://h/assets/a.png", { method: "POST", body: "x" }))).status,
    ).toBe(405);
    expect((await handler(put("a.png", new Uint8Array(0)))).status).toBe(400);
    expect((await handler(put("", new Uint8Array([1])))).status).toBe(400);
  });

  it("keeps uploads inside the asset folder", async () => {
    const { handler, storage } = setup();
    const response = await handler(put("..%2F..%2Fetc%2Fpasswd.png", new Uint8Array([1])));
    expect(await response.json()).toEqual({ path: "/assets/passwd.png" });
    expect(Object.keys(storage.dump().assets)).toEqual(["passwd.png"]);
  });
});

describe("asset names", () => {
  it.each([
    ["summer-banner.jpg", "summer-banner.jpg"],
    ["Summer Banner (1).JPG", "Summer-Banner-1.JPG"],
    ["café.png", "cafe.png"],
    ["a%20b.png", "a-b.png"],
    ["../../x.png", "x.png"],
    ["dir\\x.png", "x.png"],
    [".env", "env"],
    ["...", null],
    ["", null],
  ])("%j becomes %j", (raw, expected) => {
    expect(sanitizeAssetName(raw)).toBe(expected);
  });

  it("caps long names and keeps the extension", () => {
    const name = sanitizeAssetName(`${"a".repeat(300)}.webp`)!;
    expect(name.length).toBe(200);
    expect(name.endsWith(".webp")).toBe(true);
  });

  it("suffixes before the extension", () => {
    expect(suffixedAssetName("a.tar.gz")).toMatch(/^a\.tar-[0-9a-f]{6}\.gz$/);
    expect(suffixedAssetName("README")).toMatch(/^README-[0-9a-f]{6}$/);
  });

  it("accepts image, video, font and PDF types only", () => {
    expect(isAcceptedAssetType("image/png; charset=binary")).toBe(true);
    expect(isAcceptedAssetType(null)).toBe(false);
    expect(isAcceptedAssetType("application/javascript")).toBe(false);
  });
});
