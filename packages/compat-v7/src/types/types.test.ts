import { describe, expectTypeOf, it } from "vitest";
import type * as v7 from "../__fixtures__/v7/types/index";
import type * as v7Widgets from "../__fixtures__/v7/types/widgets";
import type * as root from "../index";
import type { Flag, LoadingFallbackProps, Resolved, SectionProps } from "./index";
import type * as widgets from "./widgets";

// Type-level: `bun run typecheck` checks these; at run time they are no-ops.
const asyncLoader = async (_props: { id: string }, _req: Request) => ({ title: "t", n: 1 });
const promiseLoader = (_props: unknown): Promise<string[]> => Promise.resolve([]);
const syncLoader = (_props: { id: string }) => ({ sync: true as const });

describe("the types are v7's", () => {
  it("SectionProps: v7's result for a loader returning a Promise", () => {
    expectTypeOf<SectionProps<typeof asyncLoader>>().toEqualTypeOf<
      v7.SectionProps<typeof asyncLoader>
    >();
    expectTypeOf<SectionProps<typeof promiseLoader>>().toEqualTypeOf<
      v7.SectionProps<typeof promiseLoader>
    >();
    expectTypeOf<SectionProps<typeof asyncLoader, typeof syncLoader>>().toEqualTypeOf<{
      title: string;
      n: number;
    }>();
    expectTypeOf<SectionProps>().toEqualTypeOf<v7.SectionProps>();
    expectTypeOf<SectionProps<{ a: 1 }>>().toEqualTypeOf<v7.SectionProps<{ a: 1 }>>();
  });

  it("SectionProps: a synchronous loader gives its value (PO: Awaited<ReturnType>), where v7 gave the loader", () => {
    expectTypeOf<SectionProps<typeof syncLoader>>().toEqualTypeOf<{ sync: true }>();
    expectTypeOf<v7.SectionProps<typeof syncLoader>>().toEqualTypeOf<typeof syncLoader>();
  });

  it("Resolved, LoadingFallbackProps and Flag", () => {
    expectTypeOf<Resolved<{ a: 1 }>>().toEqualTypeOf<v7.Resolved<{ a: 1 }>>();
    expectTypeOf<LoadingFallbackProps>().toEqualTypeOf<v7.LoadingFallbackProps>();
    expectTypeOf<LoadingFallbackProps<{ x: 1 }>>().toEqualTypeOf<
      v7.LoadingFallbackProps<{ x: 1 }>
    >();
    expectTypeOf<Flag>().toEqualTypeOf<v7.Flag>();
  });

  it("every v7 widget alias, from /types/widgets, /types and the root", () => {
    expectTypeOf<widgets.ImageWidget>().toEqualTypeOf<v7Widgets.ImageWidget>();
    expectTypeOf<widgets.HTMLWidget>().toEqualTypeOf<v7Widgets.HTMLWidget>();
    expectTypeOf<widgets.VideoWidget>().toEqualTypeOf<v7Widgets.VideoWidget>();
    expectTypeOf<widgets.TextWidget>().toEqualTypeOf<v7Widgets.TextWidget>();
    expectTypeOf<widgets.RichText>().toEqualTypeOf<v7Widgets.RichText>();
    expectTypeOf<widgets.Secret>().toEqualTypeOf<v7Widgets.Secret>();
    expectTypeOf<widgets.Color>().toEqualTypeOf<v7Widgets.Color>();
    expectTypeOf<widgets.ButtonWidget>().toEqualTypeOf<v7Widgets.ButtonWidget>();
    expectTypeOf<widgets.TextArea>().toEqualTypeOf<v7Widgets.TextArea>();
    expectTypeOf<root.ImageWidget>().toEqualTypeOf<string>();
    expectTypeOf<root.SectionProps<typeof asyncLoader>>().toEqualTypeOf<{
      title: string;
      n: number;
    }>();
  });
});
