"use client";
/**
 * v7's `DeviceContext`, `DeviceProvider` and `useDevice`
 * (`@decocms/blocks@7` sdk/useDeviceContext.tsx), for the framework subpaths
 * to re-export (`@decocms/compat-v7/tanstack`, `@decocms/compat-v7/nextjs`).
 * Not an export of its own: only those two know where the request's device
 * comes from on the server.
 *
 * v7 seeded the provider from its request scope on the server and from
 * `navigator.userAgent` in the browser. v8 has no request scope, so the page
 * passes the device it detected on the server (`requestDevice()` from the
 * subpath's `/server`) as `value`; it reaches the browser with the page's
 * data, so hydration reads the same device. Without `value`, the provider
 * and `useDevice()` outside a provider fall back as v7 did when it had no
 * request: `navigator.userAgent` in the browser, `"desktop"` on the server.
 *
 * `"use client"`: Next's server components can render the provider (and
 * TanStack ignores the directive).
 */
import { createContext, createElement, type ReactNode, useContext } from "react";
import { type Device, detectDevice } from "../device.ts";

/** The resolved device, set by `DeviceProvider`. */
export const DeviceContext = createContext<Device | null>(null);

/** v7's runtime fallback, minus the request scope: the browser's user agent, else `"desktop"`. */
function runtimeDevice(): Device {
  if (typeof document === "undefined") return "desktop";
  return detectDevice(typeof navigator !== "undefined" ? navigator.userAgent : "");
}

/**
 * The device: the nearest `DeviceProvider`'s, else the browser's user agent
 * (`"desktop"` on the server). As in v7, it also works outside a React
 * render, where it skips the context.
 */
export function useDevice(): Device {
  try {
    // biome-ignore lint/correctness/useHookAtTopLevel: v7's shape: called once, unconditionally; the catch only runs outside a render
    const fromContext = useContext(DeviceContext);
    if (fromContext) return fromContext;
  } catch {
    // Not in a React render: fall through, as v7 did.
  }
  return runtimeDevice();
}

/** Gives every `useDevice()` below it `value` (the device the server detected). */
export function DeviceProvider(props: { children: ReactNode; value?: Device }): ReactNode {
  const device = props.value ?? runtimeDevice();
  return createElement(DeviceContext.Provider, { value: device }, props.children);
}
