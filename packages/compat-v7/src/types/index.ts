/**
 * v7's section and content types (`@decocms/blocks/types` on 7.x), types
 * only. Not ported: `AppContext`, `FnContext`, `App` and `Section`, which
 * describe v7's `ctx` and app runtime; v8 has neither.
 */

/**
 * The props a section receives from its loader: the loader's return value,
 * awaited. v7 unwrapped only a loader returning a `Promise`; a synchronous
 * loader gave the loader type itself. Here both give the value. `TAction` is
 * v7's unused second parameter, kept so existing annotations compile.
 */
// biome-ignore lint/correctness/noUnusedVariables: v7's signature
export type SectionProps<TLoader = any, TAction = TLoader> = TLoader extends (
  ...args: any[]
) => infer R
  ? Awaited<R>
  : TLoader;

/** v7's marker for a prop resolved before the section renders: `T` itself. */
export type Resolved<T> = T;

/** The props of a section's `LoadingFallback`. */
// biome-ignore lint/correctness/noUnusedVariables: v7's signature
export interface LoadingFallbackProps<TProps = any> {
  [key: string]: any;
}

/** A named boolean flag. */
export type Flag = {
  name: string;
  value: boolean;
};

export type {
  ButtonWidget,
  Color,
  HTMLWidget,
  ImageWidget,
  RichText,
  Secret,
  TextArea,
  TextWidget,
  VideoWidget,
} from "./widgets.ts";
