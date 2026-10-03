// telemetry.mdx › Choose where telemetry goes, verbatim.
import { createCMS } from "@decocms/blocks";
import blocks from "./.deco";
import content from "./.deco/blocks.gen";

export const cms = createCMS({
  blocks,
  content,
  telemetry: {
    endpoint: process.env.OTLP_ENDPOINT!,                            // e.g. https://otel.example.com
    headers: { authorization: `Bearer ${process.env.OTLP_TOKEN}` },  // optional
  },
});

// `headers` is optional.
export const withoutHeaders = () =>
  createCMS({ blocks, content, telemetry: { endpoint: process.env.OTLP_ENDPOINT! } });

// telemetry.mdx › Sampling, verbatim inside createCMS.
export const sampled = () =>
  createCMS({
    blocks,
    content,
    telemetry: {
      endpoint: process.env.OTLP_ENDPOINT!,
      limits: { errorSampleRate: 0.1, traceSampleRate: 0 },   // the defaults
    },
  });

// telemetry.mdx: `telemetry: { site, token }` and `telemetry: false`.
export const hostedForm = (site: string, token: string) =>
  createCMS({ blocks, content, telemetry: { site, token } });
export const off = () => createCMS({ blocks, content, telemetry: false });
