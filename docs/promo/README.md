# Next-major promotional video

A 26-second, 1080×1920 vertical MP4 with English captions, a synthesized instrumental
soundtrack, and click effects synchronized to the recorded mobile landing-page demo.
The video identifies the product as a next-major preview. The Studio/Git interaction is
the landing page's illustrative demo; this capture does not operate a real Studio or
publish a repository change.

## Recreate

Build and serve the docs from `docs/` with `bun run build` and `bun run preview`.
In another terminal, from this directory:

```sh
npm install
npx playwright install chromium
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
node capture.mjs
.venv/bin/python render.py
```

`PROMO_URL` overrides `http://localhost:4173/next/`. Capture a built preview matching
the branch's current sources. `PROMO_FONT` can specify a TrueType font on platforms
without Arial or DejaVu Sans. Python 3.10+ and Node 22+ are sufficient.

The result is `output/deco-next-vertical.mp4`. `output/timeline.json` stores the real
caption and click timestamps; `studio.png` and `final-page.png` are inspection stills.
The output folder and local dependencies are ignored by Git. Share the MP4 separately
from the source change.

## Sequence

| Approximate time | Visual | Caption |
| --- | --- | --- |
| 0–2s | Forest-green title card | Headless. Editable. AI-native. |
| 2–5s | Next home and scroll into the demo | One model. Every maker. |
| 5–7s | TypeScript pane | Write a function. |
| 7–11s | Edit pane, slider interaction | Edit it in Studio. |
| 11–15s | Save, then commit pane | Every change is a commit. |
| 15–18s | Resolve pane | Resolve it. Make it live. |
| 18–23s | Shared-content section | Working on the same content. |
| 23–26s | Closing title card | Build with Deco. |

The soundtrack is original procedural synthesis: pads, arpeggio, bass, percussion, and
clicks. It contains no downloaded music or third-party audio samples. Adjust the copy
and interactions in `capture.mjs`; edit the cards, colors, arrangement, and mix in
`render.py`. The capture adds a visible pointer and click rings only inside its own
browser session.
