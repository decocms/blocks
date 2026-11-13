// Initialize telemetry with the empty-map handle before Next reports failures,
// including non-CMS routes. The app's section map stays out of this graph.
import "./cms.proxy";

// Next's request metrics and uncaught server errors, into the CMS's telemetry.
export { onRequestError, register } from "@decocms/nextjs/instrumentation";
