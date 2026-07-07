import type { NextConfig } from "next";

// Two Next.js route-segment quirks the brief's file list didn't anticipate,
// both worked around the same way — a real segment name plus a rewrite back
// to the protocol path the admin actually calls:
//
// 1. Segments can't start with a dot — `/.decofile` is served from
//    `app/deco-decofile/route.ts`.
// 2. A segment prefixed with `_` (`_meta`) is a Next.js "private folder"
//    (https://nextjs.org/docs/app/getting-started/project-structure#private-folders)
//    and is excluded from routing entirely — confirmed empirically: building
//    the fixture with `app/live/_meta/route.ts` produced no `/live/_meta`
//    entry anywhere in `.next/app-path-routes-manifest.json` (silently
//    dropped, no build warning). `/live/_meta` is served from
//    `app/live/meta/route.ts` instead.
const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: "/.decofile", destination: "/deco-decofile" },
      { source: "/live/_meta", destination: "/live/meta" },
    ];
  },
};

export default nextConfig;
