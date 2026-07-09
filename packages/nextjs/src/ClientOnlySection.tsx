"use client";

import dynamic from "next/dynamic";
import type { ComponentType } from "react";

interface ClientOnlySectionProps {
  loader: () => Promise<{ default: ComponentType<any> }>;
  props: Record<string, unknown>;
}

const cache = new Map<() => Promise<{ default: ComponentType<any> }>, ComponentType<any>>();

export function ClientOnlySection({ loader, props }: ClientOnlySectionProps) {
  let Dynamic = cache.get(loader);
  if (!Dynamic) {
    Dynamic = dynamic(loader, { ssr: false });
    cache.set(loader, Dynamic);
  }
  return <Dynamic {...props} />;
}
