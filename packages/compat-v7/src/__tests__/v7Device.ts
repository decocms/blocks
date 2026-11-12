/**
 * Test-only. v7's own device code for the framework subpaths' tests
 * (`/tanstack`, `/nextjs`), from `src/__fixtures__/v7` (latest 7.x):
 * `v7Device` is sdk/useDeviceContext.tsx, with the request scope stubbed, and
 * `v7DetectDevice` is sdk/detectDevice.ts.
 */
import * as React from "react";
import { v7Loader } from "./loadV7";

/** v7's request scope, which its `useDevice` read on the server. */
export const v7Runtime: { current: { request: Request } | null } = { current: null };

const v7 = v7Loader({
  stubs: {
    "sdk/requestContext": { RequestContext: v7Runtime },
    react: React,
  },
});
export const v7Device = v7("sdk/useDeviceContext.tsx");
export const v7DetectDevice = v7("sdk/detectDevice.ts");
