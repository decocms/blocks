# `@decocms/native`

Deco binding for **React Native / Expo**. A site already on `@decocms/tanstack`
serves its CMS pages as JSON through `?renderJson`; this package is the
device-side half — fetch that envelope, map each section's `__resolveType` to a
native component, render.

It is deliberately **not** a second copy of the framework. There is no resolver,
no decofile, no worker entry on the device:

| Concern | Owner |
|---|---|
| Resolve the CMS page, run section loaders | the site's worker (`?renderJson`) |
| Author content | Studio, writing `.deco/blocks/` |
| Map `__resolveType` → component, render | **this package** |
| Navigation, scrolling, viewport detection | your app |

Bundling `blocks.gen.json` into an app would be actively wrong: megabytes of
content that goes stale the moment someone publishes. The whole point of
`?renderJson` is that content updates without a store release.

## Usage

```tsx
import {
  cmsScreenConfig,
  createNativeSetup,
  createRenderJsonClient,
  DecoSections,
} from "@decocms/native";
import { useQuery } from "@tanstack/react-query";
import { ScrollView } from "react-native";

const client = createRenderJsonClient({ baseUrl: "https://loja.example.com" });

createNativeSetup({
  sections: { "site/sections/Images/Banner.tsx": Banner },
});

export function HomeScreen() {
  const { data } = useQuery(cmsScreenConfig({ client, path: "/" }));
  return (
    <ScrollView>
      <DecoSections sections={data?.sections ?? []} />
    </ScrollView>
  );
}
```

## Why TanStack Query and not TanStack Router

`cmsRouteConfig` (`@decocms/tanstack`) returns a **Router** route object whose
`loader` calls a server function. Neither exists on a device, so mirroring its
literal type would produce a config nobody can spread into anything.

`cmsScreenConfig` mirrors its *ergonomics* instead — same option names
(`ignoreSearchParams`, defaulting to `["skuId"]`), same `staleTime`/`gcTime`
from the same `routeCacheDefaults` — and returns TanStack **Query** options.
Query is the part of the stack that runs natively, and the site already depends
on it. Navigation stays with Expo Router, which owns stack/tabs/gesture/deep
links.

Dropped because they only exist to feed `buildHead`: `siteName`,
`defaultTitle`, `head`, `headers`, `validateSearch`, `ssr`.

## Deferred sections

Sections the CMS marks deferred arrive as `{ component, lazyUrl }`. This package
does not fetch them for you, because *when* to fetch is a scrolling decision and
your app owns the scroll container. Resolve them with `deferredSectionConfig` —
typically from `onViewableItemsChanged` — and feed them back:

```tsx
<DecoSections
  sections={page.sections}
  resolved={resolvedByLazyUrl}
  renderPending={() => <Skeleton />}
/>
```

## `DecoSections` returns a Fragment

Not a `ScrollView`. Your app owns scrolling because it also owns
pull-to-refresh, tab bars, sticky headers and viewport detection. Wrapping here
would take that away.

## Requirements

- `@decocms/blocks` ≥ the release carrying the `react-native` export condition
  on `./sdk/requestContextStorage`. Without it, Metro resolves the
  `node:async_hooks`-backed implementation and the bundle fails with
  `Unable to resolve module node:async_hooks`.
- The site must serve `?renderJson` (on by default in `createDecoWorkerEntry`).
