# Video

v8 ships **no `Video` component**. Neither `@decocms/tanstack` nor
`@decocms/nextjs` has one, and `@decocms/blocks/image` is for images only.
Render a plain `<video>`.

Two layers decide whether a video plays with sound, and they are independent:

1. **The file.** Does the served file contain an audio track? For videos on the
   Deco media host, that depends on the URL (below).
2. **The player.** Is the `<video>` muted, and does it autoplay? That is HTML
   attributes and browser policy.

## The media host strips audio by default

Videos uploaded to Deco and served from `decoims.com` come without the audio
track unless the URL asks for it. This is behavior of the media host, not of the
v8 packages, so verify it on your URL (below).

| URL | Audio track | Size in one measured case |
|---|---|---|
| `…/video.mp4` | removed | 3.08 MB |
| `…/video.mp4?muted=true` | removed | 3.08 MB |
| `…/video.mp4?muted=false` | present | 3.59 MB |

The silent version is a different, smaller file. No player setting brings sound
back to it. Each variant is cached under its own URL, so switching to
`?muted=false` fetches a separate file with no cache-busting needed.

Verify with two requests and compare sizes:

```bash
curl -sI "<video url>"              | grep -i content-length
curl -sI "<video url>?muted=false"  | grep -i content-length
```

The `?muted=false` response should be larger.

## Do not send video through `ImageUrl`

`decoCdn` builds `https://<domain>/image?…&src=<path>` and keeps only the part
of `src` before `?`. A video passed to `Image`, `useImageUrl()` or the next/image
loader becomes an image request and loses `?muted=false`. Use the stored URL
as is.

## Browser autoplay

Browsers only autoplay muted video. To play with sound the user has to
interact (a click on `controls` or your own button). This is browser policy;
no URL or attribute changes it.

| Goal | File URL | `<video>` attributes |
|---|---|---|
| Silent background loop | default (no param) | `autoPlay muted loop playsInline` |
| Plays with sound when the user starts it | `?muted=false` | `controls`, no `autoPlay` |
| Autoplays silently, user can unmute | `?muted=false` | `autoPlay muted loop playsInline` plus a button that sets `video.muted = false` |

`playsInline` stops iOS from going fullscreen on play.

```tsx
import type { ImageWidget, VideoWidget } from "@decocms/compat-v7/types/widgets";
import { useImageUrl } from "@decocms/tanstack/react";

interface Props {
  /** @description MP4 or WebM */
  video: VideoWidget;
  poster?: ImageWidget;
  sound?: boolean;
}

function withSound(src: string) {
  if (!/^https?:\/\//.test(src)) return src; // relative paths: leave alone
  const url = new URL(src);
  url.searchParams.set("muted", "false");
  return url.href;
}

export default function HeroVideo({ video, poster, sound }: Props) {
  const imageUrl = useImageUrl();
  return (
    <video
      src={sound ? withSound(video) : video}
      poster={poster ? imageUrl(poster, { width: 1280, height: 720 }) : undefined}
      width={1280}
      height={720}
      autoPlay
      muted
      loop
      playsInline
      preload="metadata"
    />
  );
}
```

Notes on the example:

- `withSound` only makes sense for media-host URLs. Other hosts may ignore or
  reject the parameter.
- The poster is an image, so it does go through `ImageUrl`.
- `width` and `height` reserve the box, as with images.
- `preload="metadata"` avoids downloading the whole file before play. For a
  hero video that is the LCP element, consider the poster as the LCP image and
  preload that instead.

## Video fields

`VideoWidget` (from `@decocms/compat-v7/types/widgets`) or `@format video-uri`
on a string gives the field a video picker. `deco check` accepts any string
there, so it will not catch a broken video URL.

## "The video has no sound"

1. **Check the URL.** If it is a media-host URL without `?muted=false`, the
   served file has no audio. Add the parameter.
2. **Check the player.** If the URL has `?muted=false` and it is still silent,
   the element is `muted` (required for autoplay). Add `controls` or an unmute
   button.
3. **Check the code path.** If the rendered `src` is an `/image?…` URL, the
   video went through `ImageUrl`. Render the stored URL directly.
4. **Verify** by opening the `?muted=false` URL in a tab: it should play with
   sound.
