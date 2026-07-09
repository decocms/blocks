import { Suspense, type ReactNode } from "react";
import type { DeferredSection, ResolvedSection } from "@decocms/blocks/cms";
import { SectionErrorBoundary } from "@decocms/blocks/hooks";
import { SectionRenderer } from "./SectionRenderer";

interface DeferredSectionBoundaryProps {
  deferred: DeferredSection;
  promise: Promise<ResolvedSection | null>;
  pagePath: string;
  fallback?: ReactNode;
  errorFallback?: ReactNode;
}

async function ResolvedDeferredSection({
  promise,
  errorFallback,
}: {
  promise: Promise<ResolvedSection | null>;
  errorFallback?: ReactNode;
}) {
  const resolved = await promise;
  if (!resolved) return null;
  return <SectionRenderer resolved={resolved} errorFallback={errorFallback} />;
}

/**
 * Deferred/streamed section — the RSC-native analogue of DecoPageRenderer's
 * <Suspense><Await promise={promise}>{...}</Await></Suspense>. React 19
 * Server Components can await a promise directly inside an async component,
 * so there is no need for TanStack's <Await> wrapper — <Suspense> here is
 * the same React primitive TanStack also uses, just without the extra
 * unwrapping component.
 */
export function DeferredSectionBoundary({
  deferred,
  promise,
  pagePath: _pagePath,
  fallback,
  errorFallback,
}: DeferredSectionBoundaryProps) {
  const sectionId = deferred.key
    .replace(/\//g, "-")
    .replace(/\.tsx$/, "")
    .replace(/^site-sections-/, "");

  return (
    <SectionErrorBoundary sectionKey={deferred.key} fallback={errorFallback}>
      <Suspense
        fallback={
          <section id={sectionId} data-manifest-key={deferred.key} data-deferred="true">
            {fallback}
          </section>
        }
      >
        <ResolvedDeferredSection promise={promise} errorFallback={errorFallback} />
      </Suspense>
    </SectionErrorBoundary>
  );
}
