# Uploading assets and rewriting their URLs

Two jobs: how uploads work on v8, and how to move a set of assets to a new host
and point every block at the new URLs.

## The v8 upload endpoint

Uploads sit beside the content protocol. The site editor sends each file as
`PUT /assets/<name>` to the content endpoint, with the file as the body and its
own `Content-Type`. Whether an endpoint takes uploads is in its `describe`
answer: `assets` is `{ dir, urlPrefix: "/assets/", maxBytes }`, or `null` when
the endpoint is read-only or uploads go to hosted storage.

What the handler enforces (`packages/blocks/src/protocol/server/assets.ts`,
naming rules in `protocol/assets.ts`):

| Rule | Detail |
|---|---|
| Method | `PUT` only; anything else gets 405. |
| Types | `image/png`, `image/jpeg`, `image/webp`, `image/avif`, `image/gif`, `image/x-icon`, `video/mp4`, `video/webm`, `font/woff2`, `font/woff`, `font/ttf`, `font/otf`, `application/pdf` and a few legacy font and icon types. Others get 415. |
| SVG | Refused unless the handler is created with `allowSvg`, because SVG can carry scripts that run on the site's origin. |
| Name | Last path segment only. Accents removed; anything but letters, digits, `.`, `_`, `-` becomes `-`; capped at 200 characters. |
| Extension | Must match the type (`banner.html` sent as `image/png` gets 415). A name without one gets the type's (`.jpg` for JPEG). The extension is lowercased. |
| Size | Up to `maxBytes`; 413 above it. Empty bodies are refused. |
| Collisions | Never overwrites. A taken name gets a random suffix: `banner-3f9a2c.jpg`. |
| Read-only endpoint | 403. Endpoint without uploads: 404. |
| Response | `201 { "path": "/assets/<stored name>" }`. That path is what the editor stores in the field. |

### Where the file lands

With the filesystem storage (`@decocms/blocks/protocol/storage/fs`, which
serves a local working tree to the site editor), uploads go to
`public/assets/` under the app root, or the `assetsDir` option. The default
`maxBytes` is 25 MB (`assetsMaxBytes` option).

So a local upload is **a new file in the repository**, and the field holds the
relative path `/assets/<name>`. The site serves it from `public/` like any other
static file. Commit the file and deploy it with the code. If content that
points at `/assets/x.jpg` is published before the deploy that adds the file,
the image is a 404 in production until the deploy lands.

A relative `/assets/…` path is not a Deco-hosted URL, so the default `decoCdn()`
does not resize it (see [troubleshooting.md](./troubleshooting.md#not-resized)).
Upload images at the size they will be shown, or handle these paths with a
provider of your own.

For hosted drafts, `describe` reports `assets: null` and the editor uploads to
hosted storage. That storage is not part of this repository, so the URL format
it returns is not documented here. Read a field after uploading to see it.

### What v8 does not have

- No `deco` CLI command uploads assets.
- `createAssetHandler` is internal to `@decocms/blocks` (not exported), so a site
  cannot mount its own upload route from the package.
- The Fresh-era admin upload API and its cookie-based scripts are not part of
  v8.

For bulk uploads to a hosted asset store, use that store's own tools and
then rewrite URLs as below.

## Moving assets and rewriting URLs in `.deco/blocks`

Use this when assets move host: an old bucket shuts down, a migration from
another CMS, or URLs from a retired CDN. In one measured run, 1,060 assets moved
this way in about 5 minutes of upload time.

### 0. Start from current content

On a site whose content lives in Studio, run `deco pull` first, so
`.deco/blocks` matches what is published and `deco push` sends only your
changes. On a site whose content is in git, work on a branch. The commands are
covered in `deco-site-workflow`.

### 1. Inventory every reference

```bash
mkdir -p .context
grep -rhoE 'https?://[a-zA-Z0-9.-]*old-host\.example[^"'"'"'[:space:]\\)]*' .deco/blocks src \
  | sort -u > .context/old-urls.txt
wc -l .context/old-urls.txt
```

Search code (`src`) too: hardcoded URLs move with the content.

Watch for **wrapped URLs**. Some transform services wrap the original with a
single slash, such as `https://transform.example/tr:w-1620/https:/old-host.example/a.jpg`.
The regex above misses the inner one. After the bulk pass, grep for the bare
host name, without a scheme.

### 2. Upload each asset and record a mapping

For each URL: download it, read the real `Content-Type` (old URLs are often
UUIDs with no extension), give the file the matching extension, upload it,
and append one line to a mapping file:

```json
{"old":"https://old-host.example/a/7f3c…","new":"https://<new host>/<path>/banner.jpg","mime":"image/jpeg"}
```

Rules that save a rerun:

- Dedupe the inventory first (`sort -u`). Uploading a URL twice creates two
  assets.
- Map MIME to extension from the download response, not from the URL. A file
  saved as `.bin` will not render. On the v8 endpoint a wrong extension is
  refused (415).
- Keep a separate error log, and retry only the failures.
- Run a few uploads in parallel (around 6), not hundreds. Watch for rate
  limiting and expiring credentials in the error log.

### 3. Check the mapping before touching any file

```bash
# every URL was mapped
wc -l .context/old-urls.txt .context/asset-mapping.jsonl
diff <(sort -u .context/old-urls.txt) \
     <(sed -n 's/.*"old":"\([^"]*\)".*/\1/p' .context/asset-mapping.jsonl | sort -u)
# every entry has a new URL
grep -cv '"new":"' .context/asset-mapping.jsonl   # must print 0
```

If any check fails, stop and fix the mapping first.

### 4. Replace with plain strings, not regex

URLs are full of characters that mean something in regex and `sed` (`/`, `.`,
`?`, `&`). Use exact string replacement:

```ts
// .context/rewrite.ts — run with: bun .context/rewrite.ts  (or node)
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const map = readFileSync(".context/asset-mapping.jsonl", "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l) as { old: string; new: string });
const dir = ".deco/blocks";
let total = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  const path = join(dir, file);
  const before = readFileSync(path, "utf8");
  let after = before;
  for (const { old, new: next } of map) {
    const n = after.split(old).length - 1;
    if (n) { total += n; after = after.split(old).join(next); }
  }
  if (after !== before) writeFileSync(path, after);
}
console.log(`replaced ${total} references`);
```

Write the file back byte for byte apart from the URLs: do not re-serialize
the JSON, so the git diff shows only the URL lines. (`deco diff` compares a
hash of each block's canonical JSON, so formatting alone does not show there.)

### 5. Verify

```bash
grep -rn "old-host.example" .deco/blocks src     # expect nothing
```

Anything left is usually a wrapped URL. Replace the whole wrapping URL with the
new one; the image CDN does the resizing, so the old transform wrapper is not
needed.

Then:

- `deco diff` lists changed blocks by name: only the blocks you expect
  should be there. `git diff .deco/blocks` shows the lines.
- Open a few changed pages locally and check the images load.
- `deco push --draft=<name>`, then `deco check --draft=<name>` and preview the
  draft. Nothing goes live until `deco publish --draft=<name>`.

`deco check` validates block structure, not URLs: image and video fields
accept any string. Checking that images load is up to you.

### 6. Keep the mapping

`.context/` is often git-ignored. If the mapping matters later (rollback,
audit, a second pass over code), save it somewhere committed.

## Pitfalls

| Pitfall | What happens | Fix |
|---|---|---|
| URL with no extension | File uploaded with the wrong type, or refused | Use the download's `Content-Type` |
| Same URL uploaded twice | Two assets, the mapping keeps one | Dedupe first, track in the mapping |
| Wrapped URLs | Stragglers after the bulk pass | Grep the bare host after step 4 |
| `sed` replacement | Broken URLs, partial matches | Plain string replacement |
| Credentials expire mid-run | Uploads start failing quietly | Watch the error log, retry failures |
| Publishing before the files exist | 404 images in production | Upload and deploy first, publish content last |
