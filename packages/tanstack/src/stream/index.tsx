/**
 * A TanStack Start stream handler for React 19 Web Streams (Cloudflare Workers).
 * React reports failures inside Suspense through onError, even after a 200
 * response has started. Keep those failures on the site's telemetry pipeline.
 */
import { reportError } from "@decocms/blocks/telemetry";
import * as ssr from "@tanstack/react-router/ssr/server";
import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server.edge";
import { currentScope } from "../scope/server.ts";

/** Use with createStartHandler(decoStreamHandler) in the site's server entry. */
export const decoStreamHandler = ssr.defineHandlerCallback(
  async ({ request, router, responseHeaders }) => {
    const signal = request.signal;
    if (signal.aborted) {
      router.serverSsr?.cleanup();
      throw signal.reason;
    }
    // Only this opt-in handler needs the newer streaming lifecycle API. A
    // namespace import keeps existing binding exports importable on older routers.
    if (
      !("createSsrStreamResponse" in ssr) ||
      typeof ssr.createSsrStreamResponse !== "function" ||
      !("getSsrStatus" in ssr) ||
      typeof ssr.getSsrStatus !== "function" ||
      !("waitForRequest" in ssr) ||
      typeof ssr.waitForRequest !== "function"
    ) {
      throw new Error(
        "decoStreamHandler requires @tanstack/react-router >=1.170.39 and @tanstack/react-start >=1.168.58",
      );
    }

    const reportInRequest = currentScope()?.reportError;
    const reported = new Set<unknown>();
    let rendererTeardown = false;
    const onError = (error: unknown, info?: unknown) => {
      if (rendererTeardown || signal.aborted || reported.has(error)) return;
      reported.add(error);
      try {
        console.error("Error in renderToReadableStream:", error, info);
      } catch {
        // A site's console wrapper must not interrupt rendering or reporting.
      }
      try {
        if (reportInRequest) reportInRequest(error);
        else {
          void reportError(error, {
            framework: "tanstack",
            source: "render",
            route: () => router.state.matches.at(-1)?.fullPath,
            method: request.method,
          });
        }
      } catch {
        // Instrumentation never replaces a renderer's error.
      }
    };

    try {
      const stream = await renderToReadableStream(<ssr.RouterServer router={router} />, {
        signal,
        nonce: router.options.ssr?.nonce,
        progressiveChunkSize: Number.POSITIVE_INFINITY,
        onError,
      });
      const rendererAbort = isbot(request.headers.get("User-Agent"))
        ? new AbortController()
        : undefined;
      const responseStream = ssr.transformReadableStreamWithRouter(router, stream, {
        rendererSafePoint: "script-close",
        signal,
        onAbort: (reason) => {
          rendererTeardown = true;
          rendererAbort?.abort(reason);
        },
      });
      if (rendererAbort) await ssr.waitForRequest(stream.allReady, rendererAbort.signal);
      return ssr.createSsrStreamResponse(
        router,
        new Response(responseStream, {
          status: ssr.getSsrStatus(router),
          headers: responseHeaders,
        }),
      );
    } catch (error) {
      onError(error);
      router.serverSsr?.cleanup();
      throw error;
    }
  },
);
