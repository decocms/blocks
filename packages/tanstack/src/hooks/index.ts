export {
  DecoPageRenderer,
  SectionList,
  SectionRenderer,
} from "./DecoPageRenderer";
export { DecoRootLayout, type DecoRootLayoutProps } from "./DecoRootLayout";
export { DraftPreviewIndicator } from "./DraftPreviewIndicator";
export { NavigationProgress } from "./NavigationProgress";
export { StableOutlet } from "./StableOutlet";
export { default as PreviewProviders } from "./PreviewProviders";
// Re-exported for backward compat — the hook itself lives in `@decocms/blocks`
// (framework-agnostic core) so `@decocms/nextjs` can use it too.
export { useExperiment, type ExperimentResult } from "@decocms/blocks/hooks";
