# Troubleshooting images

Start from the symptom. Most checks need two things: the `src` stored in the
content (in `.deco/blocks` or the loader's output) and the URL the page actually
requested (DevTools, Network, filter "Img").

| Symptom | Likely cause | Section |
|---|---|---|
| Every image on the site is a bit soft | No tier, or `low`, in `decoCdn` | [Soft everywhere](#soft-everywhere) |
| One banner is pixelated, worse on phones and Retina screens | Source has fewer pixels than the slot needs | [Undersized source](#undersized-source) |
| A full-width hero is soft only on wide screens | `sizes` default says 50vw | [Wrong sizes](#wrong-sizes) |
| Images are huge (MBs) and slow | Source passes through unresized | [Not resized](#not-resized) |
| 404 or 508 on `/image?…` | Bad `src` inside the CDN URL | [Broken CDN URLs](#broken-cdn-urls) |
| Image blocked, console shows a CSP error | Host missing from `img-src` | [providers-and-cdn.md](./providers-and-cdn.md#hosts-for-csp-and-preconnect) |
| Mobile crop looks wrong, desktop fine | `Source` ratios differ per breakpoint | [Mobile crop](#mobile-crop) |
| Page jumps as images load | Missing `width`/`height` | [quality-and-lcp.md](./quality-and-lcp.md#preloading-the-lcp-image) |

## Soft everywhere

Look at the `quality` parameter on any requested `/image?…` URL.

- **No `quality` parameter**: the site's `decoCdn` has no `quality` option, so
  the CDN default applies to every image. Set `decoCdn({ quality: "high" })`.
- **`quality=low`**: someone chose `low` site-wide. Raise it.
- **Not a Deco CDN URL at all**: the image came from a platform provider.
  VTEX providers have their own scale (default 8 of 10); Shopify's ignores
  quality.

A site-wide tier change touches every image URL, so the CDN cache refills
once. That is expected.

## Undersized source

The most common "distorted image" report is not stretching. It is a source with
fewer pixels than the slot needs on a high-density screen, upscaled by the
browser. Tell-tale sign: **sharp when the file is opened directly, pixelated on
the site.** Opening it shows its small native size; the site shows it larger.

**Mechanism.** `width` on `Image` or `Source` is the 1x CSS width. The srcset
also offers `2 × width`, and on a DPR 2 screen the browser takes that one. If
the uploaded file is smaller, the CDN or browser has to invent pixels. No
parameter fixes that: `quality: "original"` only adds bytes.

**Required source pixels = rendered CSS width × device pixel ratio.** Use 2x as
the target; most phones and laptops are DPR 2 or more.

### Diagnose

1. Measure the **original** file, not a resized URL. Take the `src` from the
   content (before it went through `ImageUrl`) and download that:

   ```bash
   curl -sL "<original src>" -o /tmp/orig
   sips -g pixelWidth -g pixelHeight /tmp/orig   # macOS; or: identify /tmp/orig
   ```

   Measuring a `/image?width=1400…` URL reports 1400, the output size, which
   hides the problem.
2. Read the `width` on the component. Each `Source` has its own:

   ```tsx
   <Source media="(min-width: 1024px)" src={desktop} width={700} height={342} /> // needs 1400×684
   <Source media="(max-width: 1023px)" src={mobile} width={375} height={184} />  // needs 750×368
   ```
3. Source width ≥ `width × 2`: sharp. Smaller: that is the bug. In one measured
   case a 542px-wide file filled a slot that needed 1400px, a 2.6x upscale.

### Fix

Upload a larger source, at least 2x the slot, in the slot's aspect ratio. Larger
is fine: the CDN downscales, which never blurs.

These do **not** fix it:

- Changing `width`/`height` on the component. The slot on screen is the same,
  so the browser upscales anyway.
- `quality: "original"`. No detail is added. Go back to `"high"`.
- Shrinking the component with CSS. It only helps below half the source width,
  and it changes the design everywhere the component is used.

No larger original? An AI upscaler can help. Choose a scale that clears the
target (3x on 542px gives 1626px, above 1400; 2x gives 1084px, below). Check
fine detail (text, logos, small product features) before shipping. A real
high-resolution photo is always better.

Then stop it from happening again: put the 2x size in the field's
`@description` (see [components-per-binding.md](./components-per-binding.md#image-fields-in-section-props)).

### Explaining it to a non-technical stakeholder

> The image looks pixelated because the uploaded file is smaller than the space
> it fills. The banner needs 1400×684 px (750×368 px on mobile); the current file
> is 542×280 px, so the site has to stretch it. It looks sharp when you open the
> file because it is shown at its small original size there. Upload the image at
> the larger size, ideally the original high-resolution photo.

## Wrong sizes

`Image` defaults `sizes` to `"(max-width: 768px) 100vw, 50vw"`. On a 1440px
screen that tells the browser a full-width hero is 720 CSS px wide, so it may
pick the 1x candidate. Set `sizes` to the real layout (see
[quality-and-lcp.md](./quality-and-lcp.md#sizes-and-the-srcset)).

## Not resized

The requested URL equals the `src` in the content: no provider matched it.

- `imageUrl.isOptimizable(src)` returns false for it. Check in a test or a
  console.
- `decoCdn()` without `sources` resizes only Deco-hosted URLs. For other hosts,
  add the platform provider or use `decoCdn({ sources: "all" })`.
- A provider listed after `decoCdn({ sources: "all" })` never runs. Move it
  earlier.
- `data:` URIs and empty strings are never resized, by design.
- On Next.js, a source no provider resizes goes to `fallback`, or is returned
  unchanged. Pass `fallback: nextImageOptimizer` if you want Next to resize it.
- A relative path like `/assets/banner.jpg` is not a Deco-hosted URL, so the
  default `decoCdn()` leaves it alone and the site serves the file as is. With
  `sources: "all"` it becomes `src=/assets/banner.jpg` on the CDN. Check that the
  CDN can serve such a URL before relying on it.

## Broken CDN URLs

- **`src=image` or `src=<cdn>/image`**: an already-resized URL was resized
  again by older code. v8 `decoCdn` unwraps these. If you still see them, some
  code builds CDN URLs by hand; switch it to `imageUrl`.
- **508 on `assets.decocms.com` or `decoims.com`**: the `src` points back at
  `decoims.com`, and the CDN fetches itself. `decoCdn` strips `decoims.com`
  from sources when it is in `legacyHosts` (the default on those domains). A
  custom `legacyHosts: []` on a Cloudflare domain brings the loop back.
- **404 with a valid-looking `src`**: characters like `%`, `&`, `#`, `+` in a
  file name. `decoCdn` escapes them only when it unwraps a nested URL; rename
  such files when you upload them. The v8 upload endpoint already does (see
  [asset-upload.md](./asset-upload.md)).
- **The query string on the source disappeared**: `decoCdn` drops everything
  after `?` in `src`. A source that needs its query (signed URLs) must not go
  through `decoCdn`; give it its own provider or leave it unmatched.

## Mobile crop

A `Picture` has a `Source` per media query, each with its own `width` and
`height`, so the ratio can differ. With `fit: "cover"` (the default) the CDN
crops to that ratio. A common bug: desktop is 700×342 (about 2:1) and mobile
is 350×350, so the mobile photo is cropped to a square. Decide the intended
mobile shape by looking at the live mobile render (emulate the device and DPR,
take a screenshot), then make the `Source` and the uploaded file agree.
