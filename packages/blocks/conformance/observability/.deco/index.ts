// telemetry.mdx › Your own tracing, verbatim (paths adjusted to this fixture).
import { trace } from "@opentelemetry/api";
import type { Blocks } from "@decocms/blocks";
import { PromoBanner } from "../promo-banner";

const tracer = trace.getTracer("my-store");

// Runs a block function inside a span named after its block type.
function traced<P, R>(type: string, fn: (props: P) => R) {
  return (props: P) =>
    tracer.startActiveSpan(type, async (span) => {
      try {
        return await fn(props);
      } catch (error) {
        span.recordException(error as Error);
        throw error;
      } finally {
        span.end();
      }
    });
}

export default {
  "promo-banner": traced("promo-banner", PromoBanner),
} satisfies Blocks;
