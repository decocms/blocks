import { createElement, type ReactNode } from "react";
import {
  getSection,
  getSectionOptions,
  getSyncComponent,
} from "@decocms/live/cms";
import type { ResolvedSection } from "@decocms/live/cms";
import { SectionErrorBoundary } from "@decocms/live/hooks";
import { ClientOnlySection } from "./ClientOnlySection";

interface SectionRendererProps {
  resolved: ResolvedSection;
  errorFallback?: ReactNode;
}

/**
 * Renders one resolved section. Runs inside an async Server Component tree,
 * so code-split sections are loaded via a plain await — no client-side
 * React.lazy/Suspense needed for content in the initial response.
 */
export async function SectionRenderer({ resolved, errorFallback }: SectionRendererProps) {
  const sectionId = resolved.key
    .replace(/\//g, "-")
    .replace(/\.tsx$/, "")
    .replace(/^site-sections-/, "");

  const options = getSectionOptions(resolved.component);
  const errFallback = options?.errorFallback
    ? createElement(options.errorFallback, { error: new Error("") })
    : errorFallback;

  const isClientOnly = options?.clientOnly === true;
  const SyncComp = getSyncComponent(resolved.component);
  let content: ReactNode;

  if (isClientOnly) {
    const loader = getSection(resolved.component);
    if (!loader) {
      console.warn(`[SectionRenderer] No component registered for: ${resolved.component}`);
      return null;
    }
    content = <ClientOnlySection loader={loader} props={resolved.props} />;
  } else if (SyncComp) {
    content = createElement(SyncComp, resolved.props);
  } else {
    const loader = getSection(resolved.component);
    if (!loader) {
      console.warn(`[SectionRenderer] No component registered for: ${resolved.component}`);
      return null;
    }
    const mod = await loader();
    content = createElement(mod.default, resolved.props);
  }

  return (
    <section id={sectionId} data-manifest-key={resolved.key}>
      <SectionErrorBoundary sectionKey={resolved.key} fallback={errFallback}>
        {content}
      </SectionErrorBoundary>
    </section>
  );
}
