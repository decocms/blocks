import content from "../.deco/blocks.gen";

// Everything createCMS takes except the block map, shared by the app's handle (./cms.ts) and
// the proxy's (./cms.proxy.ts): the same options give one instance per process. createCMS reads
// NODE_ENV itself, so `next dev` serves the local content and `next start` the hosted release.
// The smoke points telemetry at its local OTLP sink; the site sends none otherwise.
const otlp = process.env.SMOKE_OTLP_ENDPOINT;
// A hosted site previews where Studio's release metadata says; this bundled content lists the
// host the smoke previews on (x-forwarded-host) in code.
export const cmsConfig = {
  content,
  telemetry: otlp ? { endpoint: otlp } : (false as const),
  preview: { hosts: ["binding-smoke.deco.site"] },
};
