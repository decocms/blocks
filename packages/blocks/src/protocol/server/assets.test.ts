// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  assetNameForType,
  isAcceptedAssetType,
  sanitizeAssetName,
  suffixedAssetName,
} from "../assets";
import { ErrorCode } from "../errors";
import { createMemoryStorage, type MemoryStorageOptions } from "../storage/memory";
import { createAssetHandler } from "./assets";

function setup(options: MemoryStorageOptions = {}, allowSvg?: boolean) {
  const storage = createMemoryStorage(options);
  return { storage, handler: createAssetHandler(storage, { allowSvg }) };
}

const put = (
  name: string,
  body: BodyInit,
  type = "image/png",
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
    const response = await handler(
      put("summer-banner.jpg", new Uint8Array([1, 2, 3]), "image/jpeg"),
    );
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
    ["image/webp", "f.webp"],
    ["image/jpeg", "f.jpeg"],
    ["image/avif", "f.avif"],
    ["image/gif", "f.gif"],
    ["video/mp4", "f.mp4"],
    ["video/webm", "f.webm"],
    ["font/woff2", "f.woff2"],
    ["font/ttf", "f.ttf"],
    ["application/pdf", "f.pdf"],
  ])("accepts %s as %s", async (type, name) => {
    const { handler } = setup();
    const response = await handler(put(name, new Uint8Array([1]), type));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ path: `/assets/${name}` });
  });

  it.each([
    "application/json",
    "text/html",
    "application/javascript",
    "application/x-www-form-urlencoded",
    "image/x-unknown",
    "",
  ])("refuses %j with HTTP 415", async (type) => {
    const { handler } = setup();
    expect((await handler(put("f.png", new Uint8Array([1]), type))).status).toBe(415);
  });

  it.each([
    ["evil.html", "image/png"],
    ["evil.htm", "image/jpeg"],
    ["evil.js", "image/png"],
    ["evil.svg", "image/png"],
    ["banner.png", "image/jpeg"],
    ["font.woff2", "application/pdf"],
  ])("refuses %s sent as %s: the extension must match the type (HTTP 415)", async (name, type) => {
    const { handler, storage } = setup();
    const response = await handler(put(name, "<script>alert(1)</script>", type));
    expect(response.status).toBe(415);
    expect(((await response.json()) as { error: { code: number } }).error.code).toBe(
      ErrorCode.InvalidRequest,
    );
    expect(storage.dump().assets).toEqual({});
  });

  it("gives a name without an extension its type's extension, and lowercases it", async () => {
    const { handler } = setup();
    expect(await (await handler(put("banner", new Uint8Array([1]), "image/webp"))).json()).toEqual({
      path: "/assets/banner.webp",
    });
    expect(
      await (await handler(put("Photo.JPG", new Uint8Array([1]), "image/jpeg"))).json(),
    ).toEqual({ path: "/assets/Photo.jpg" });
  });

  it("refuses SVG (it can carry scripts) unless allowSvg is set", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    expect((await setup().handler(put("logo.svg", svg, "image/svg+xml"))).status).toBe(415);
    const allowed = await setup({}, true).handler(put("logo.svg", svg, "image/svg+xml"));
    expect(allowed.status).toBe(201);
    expect(await allowed.json()).toEqual({ path: "/assets/logo.svg" });
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
    expect(isAcceptedAssetType("IMAGE/PNG")).toBe(true);
    expect(isAcceptedAssetType(null)).toBe(false);
    expect(isAcceptedAssetType("application/javascript")).toBe(false);
    expect(isAcceptedAssetType("image/svg+xml")).toBe(false);
    expect(isAcceptedAssetType("image/svg+xml", { allowSvg: true })).toBe(true);
  });

  it.each([
    ["a.png", "image/png", "a.png"],
    ["a.PNG", "image/png", "a.png"],
    ["a", "image/png", "a.png"],
    ["a.jpg", "image/jpeg", "a.jpg"],
    ["a.jpeg", "image/jpeg", "a.jpeg"],
    ["a.tar.pdf", "application/pdf", "a.tar.pdf"],
    ["a.html", "image/png", null],
    ["a.png", "text/html", null],
  ])("assetNameForType(%j, %j) is %j", (name, type, expected) => {
    expect(assetNameForType(name, type)).toBe(expected);
  });
});
