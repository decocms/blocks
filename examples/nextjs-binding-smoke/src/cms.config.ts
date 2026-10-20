import content from "../.deco/blocks.gen";

// Everything createCMS takes except the block map, shared by the app's handle (./cms.ts) and
// the proxy's (./cms.proxy.ts): the same options give one instance per process. createCMS reads
// NODE_ENV itself, so `next dev` serves the local content and `next start` the hosted release.
// The smoke points telemetry at its local OTLP sink; the site sends none otherwise.
const otlp = process.env.SMOKE_OTLP_ENDPOINT;
export const cmsConfig = { content, telemetry: otlp ? { endpoint: otlp } : (false as const) };

// Where drafts preview: only the hosts Deco runs the site on (v7's default for a site that
// declares no preview hosts; the empty list says so explicitly), the same in the proxy and the pages.
export const preview = { site: "binding-smoke", previewHosts: [] as string[] };
