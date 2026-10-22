// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useExperiment } from "./useExperiment.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Arm({ test }: { test: string }) {
  const { variant, isTreatment, ready } = useExperiment(test);
  return (
    <span
      data-variant={variant ?? "none"}
      data-treatment={String(isTreatment)}
      data-ready={String(ready)}
    />
  );
}

type AbWindow = typeof globalThis & { __ab?: unknown };

/** A stand-in for the SDK: `ready` fires only when the test says it resolved. */
function installSdk(assignments: Record<string, string>) {
  const queue: ((api: unknown) => void)[] = [];
  const api = {
    ready: (cb: (api: unknown) => void) => queue.push(cb),
    variant: (test: string) => assignments[test] ?? null,
  };
  (globalThis as AbWindow).__ab = api;
  return {
    resolve: () =>
      act(() => {
        for (const cb of queue.splice(0)) cb(api);
      }),
  };
}

const read = (container: HTMLElement) => {
  const el = container.querySelector("span") as HTMLElement;
  return { variant: el.dataset.variant, treatment: el.dataset.treatment, ready: el.dataset.ready };
};

describe("on the server", () => {
  it("renders the control and is not ready — the SDK has not run", () => {
    const out = renderToStaticMarkup(<Arm test="hero" />);
    expect(out).toContain('data-ready="false"');
    expect(out).toContain('data-variant="none"');
    expect(out).toContain('data-treatment="false"');
  });
});

describe("in the browser", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    (globalThis as AbWindow).__ab = undefined;
  });

  /**
   * THE HYDRATION RULE. The SDK resolves after an await, so the first client
   * render must still be the server's — a component that disagreed with the
   * HTML would have React silently keep the wrong arm on screen, and the
   * experiment would report treatment traffic that never saw the treatment.
   */
  it("first client render matches the server's, then the arm arrives", () => {
    const sdk = installSdk({ hero: "variant" });
    act(() => root.render(<Arm test="hero" />));
    expect(read(container)).toEqual({ variant: "none", treatment: "false", ready: "false" });
    expect(container.innerHTML).toBe(renderToStaticMarkup(<Arm test="hero" />));

    sdk.resolve();
    expect(read(container)).toEqual({ variant: "variant", treatment: "true", ready: "true" });
  });

  it("calls the control arm a non-treatment", () => {
    const sdk = installSdk({ hero: "control" });
    act(() => root.render(<Arm test="hero" />));
    sdk.resolve();
    expect(read(container)).toEqual({ variant: "control", treatment: "false", ready: "true" });
  });

  it("resolves as ready with no SDK on the page, rather than waiting forever", () => {
    act(() => root.render(<Arm test="hero" />));
    expect(read(container)).toEqual({ variant: "none", treatment: "false", ready: "true" });
  });

  it("a test the visitor is not in is the control, and still ready", () => {
    const sdk = installSdk({ other: "variant" });
    act(() => root.render(<Arm test="hero" />));
    sdk.resolve();
    expect(read(container)).toEqual({ variant: "none", treatment: "false", ready: "true" });
  });

  it("gives each test its own arm", () => {
    const sdk = installSdk({ hero: "variant", nav: "control" });
    act(() => {
      root.render(
        <>
          <Arm test="hero" />
          <Arm test="nav" />
        </>,
      );
    });
    sdk.resolve();
    expect([...container.querySelectorAll("span")].map((s) => s.dataset.variant)).toEqual([
      "variant",
      "control",
    ]);
  });

  it("does not set state from a callback that lands after unmount", () => {
    const sdk = installSdk({ hero: "variant" });
    act(() => root.render(<Arm test="hero" />));
    act(() => root.unmount());
    expect(() => sdk.resolve()).not.toThrow();
  });
});
