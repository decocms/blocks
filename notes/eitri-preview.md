# Eitri preview — architecture, Eitri questions, preview-provider protocol

> Companion to [`eitri-stack-design.md`](./eitri-stack-design.md) and
> [`deco-fs-contract.md`](./deco-fs-contract.md). Studio now decouples the CMS
> pane from the preview pane, and the preview can live in a **different
> environment** than Studio. This doc records how we intend to preview an Eitri
> app (which deco does **not** render), the questions that gate it, and the
> provider protocol any external preview must implement.

## Why preview is even possible here

`eitri-luminus` is a **DaisyUI-4 / Tailwind wrapper over plain HTML web-React**
(`View`→`div`, `Text`→`span`, `Image`→`img`) — **not** React Native. So an Eitri
page can render in an ordinary browser; no device emulator / Metro / RN-web
needed. That is the enabler for an embeddable web preview.

**Blocker:** `eitri-luminus` / `eitri-bifrost` / `eitri-commons` are **not on
public npm** (only `eitri-cli` is). They resolve from Eitri's own registry via
`eitri-cli`. So any preview must go through Eitri's toolchain/registry — we
cannot bundle luminus standalone.

## Options considered

| | Fidelity | Coupling / cost | Verdict |
|---|---|---|---|
| **A. Eitri-hosted web preview, embedded in Studio** | Real | Needs Eitri to expose an embeddable preview + a way to inject page content | **Preferred** |
| **B. Run `eitri-cli` in a deco sandbox** | Real | Needs headless `eitri start` + Eitri auth + registry egress | Fallback if A isn't hosted |
| **C. Reimplement luminus primitives ourselves** | Approximate | We'd fork+maintain someone else's UI kit; silent drift; preview lies subtly | **Rejected** |

C is rejected deliberately: a CMS preview that is *approximate by construction*
is worse than none, and owning a fork of luminus is permanent, growing debt.

**Plan:** pursue **A** as the real answer; keep **B** as the fidelity fallback
if Eitri can't host an embed. Both implement the same provider protocol below,
so Studio doesn't care which is in use.

## Questions for the Eitri team (gate A and B)

1. **Embeddable web preview.** Do you expose a browser preview of an app
   (iframe-able URL)? Can it render an **arbitrary page composition with
   supplied props** (not only the published app) — i.e. render "these sections,
   in this order, with these props"?
2. **Injecting content.** How can an external editor hand you the content to
   render — a render endpoint (URL with props/decofile), a `postMessage` channel,
   or an API? (We'd like to map it to deco's `/live/previews/*` + a live
   `postMessage` rerender channel; see the protocol below.)
3. **Live vs published.** Can a preview render **dev/workspace** sections
   (unpublished, as served at `api.eitri.tech/.../sections/<path>`), or must
   sections be published first? We need live preview of in-editor state.
4. **Headless CLI.** Can `eitri start` (or equivalent) run **non-interactive /
   headless** (CI mode, no prompts) and serve the web preview on a known port?
   (Gates running it in our sandbox — option B.)
5. **Automation auth.** How does a **service/automation** authenticate (token /
   service account) to run or preview an app without interactive login? What
   scopes?
6. **Registry egress.** Which hosts must a sandbox reach to resolve
   `eitri-luminus`/`bifrost` (and run a preview), and are there access / rate
   constraints for CI-style usage?
7. **Concurrency & teardown.** Constraints on running many app previews
   concurrently (per workspace), and expected lifecycle/teardown?
8. **Device chrome.** Does your web preview already render a mobile device
   frame, or should Studio supply the phone frame?

## Preview-provider protocol (v1)

The key realization: **this is not a new protocol.** A decoupled preview
provider implements deco's *existing* preview surface, just hosted at a
configurable origin. Two layers, both already in `@decocms/blocks-admin`:

### 1. Render contract — `/live/previews/*`

The provider serves a render endpoint compatible with deco's
`resolvePreviewRequest` (`packages/blocks-admin/src/admin/resolvePreview.ts`):

- `GET /live/previews/<encodeURIComponent(blockKey)>?props=<json>` — render one
  block with props; `?resolveChain=<key>` and `?__decofile=<json>` are also
  honored.
- `POST /live/previews/page` with body
  `{ "__resolveType": "website/pages/Page.tsx", "__props": { …page… }, "__decofile": { …optional block map… } }`
  — render a full page composition. `__decofile` lets references
  (`{ "__resolveType": "<saved block>" }`) and loader-typed props resolve.

Response: rendered HTML. For Eitri this HTML is produced by Eitri's runtime
(A) or by `eitri-cli` in our sandbox (B) — deco never renders it.

### 2. Live channel — `editor::inject` postMessage

Studio embeds `preview.url` in an iframe and drives live updates over
`postMessage`, reusing the `LiveControls` channel
(`packages/blocks/src/hooks/LiveControls.tsx`, admin side
`packages/blocks-admin/src/admin/liveControls.ts`):

- Studio → iframe: `editor::inject` (rerender with the current unsaved decofile,
  scroll-to-section, inject). On each edit (debounced), Studio pushes the live
  page state so the preview re-renders without a full reload.
- iframe → Studio (recommended additions for a clean external provider):
  `deco.preview.ready` (before first render), `deco.preview.error`
  `{ message, sectionKey? }` (surface render failures in the form),
  `deco.preview.resize { height }`, and optionally `deco.preview.select
  { blockId }` for click-to-select (deco tags sections with
  `data-manifest-key`).

**Security:** both sides validate `event.origin` against the configured
preview origin; if `auth.kind = "bearer"`, Studio attaches the token to the
render request and the provider enforces it.

> Action: reconcile the exact `editor::inject` message shape with the current
> `LiveControls` implementation before Eitri implements against it — extend that
> channel, don't fork a parallel one.

### 3. App-level config — `.deco/preview.json`

Where the preview lives is per-app config (versioned with the app; overridable
in Studio):

```jsonc
{
  "preview": {
    "provider": "eitri" | "sandbox" | "url",
    "url": "https://preview.eitri.tech/app/<appId>",  // the embeddable origin
    "transport": "postMessage",                        // v1: postMessage only
    "device": { "frame": "iphone-15" | "android" | "none", "width": 390, "height": 844 },
    "auth": { "kind": "none" | "bearer", "tokenRef": "SECRET_NAME" }
  }
}
```

- `provider` selects the environment; `url` is its origin. `eitri` → an
  Eitri-hosted endpoint (A); `sandbox` → our `eitri-cli` sandbox (B); `url` →
  any compatible environment.
- `device` gives Studio a **mobile frame** (a genuinely Eitri-specific nicety —
  these are phone apps; render inside phone chrome with presets).
- `auth.tokenRef` names a secret, never an inline token.

Studio behavior: load `preview.url` in the framed iframe → wait for
`deco.preview.ready` → push the live decofile via the render contract /
`editor::inject` on every edit → show `deco.preview.error` inline.

## Open decisions

- **A vs B** is decided by the Eitri answers (Q1–Q6).
- Whether `preview.json` lives in `.deco/` (versioned) or only in Studio app
  settings — leaning `.deco/` so it travels with the app, Studio override on top.
- Exact `editor::inject` shape to standardize (reconcile with `LiveControls`).
