// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { ANALYTICS_SCRIPT } from "./analytics";

type IOCb = (entries: { isIntersecting: boolean; target: Element }[]) => void;

function setup() {
  const observed: Element[] = [];
  const active = new Set<Element>();
  let ioCb: IOCb = () => {};
  let moCb: (r: { addedNodes: Node[] }[]) => void = () => {};
  const w = window as any;
  w.IntersectionObserver = class {
    constructor(cb: IOCb) {
      ioCb = cb;
    }
    // Like the real IntersectionObserver: observe() on an observed element is a no-op,
    // observe() after unobserve() starts a fresh observation (=> a fresh entry).
    observe(el: Element) {
      if (active.has(el)) return;
      active.add(el);
      observed.push(el);
    }
    unobserve(el: Element) {
      active.delete(el);
    }
  };
  w.MutationObserver = class {
    constructor(cb: typeof moCb) {
      moCb = cb;
    }
    observe() {}
  };
  w.requestIdleCallback = (cb: () => void) => cb();
  w.dataLayer = [];
  new Function(ANALYTICS_SCRIPT)();
  return {
    observed,
    fire: (el: Element) => ioCb([{ isIntersecting: true, target: el }]),
    added: (n: Node) => moCb([{ addedNodes: [n] }]),
  };
}

const ev = (name: string) =>
  `data-event="${encodeURIComponent(JSON.stringify({ name, params: { a: 1 } }))}" data-event-trigger="view"`;

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ANALYTICS_SCRIPT", () => {
  it("dispatches a view once and never re-observes a fired element", () => {
    document.body.innerHTML = `<div id="a" ${ev("view_item_list")}></div>`;
    const { observed, fire, added } = setup();
    const a = document.getElementById("a") as Element;
    expect(observed).toEqual([a]);
    fire(a);
    expect((window as any).dataLayer).toEqual([{ event: "view_item_list", a: 1 }]);
    // an unrelated mutation that re-adds the fired element must not re-observe it
    added(a);
    expect(observed.filter((e) => e === a)).toHaveLength(1);
  });

  it("observes only added nodes and their matching descendants", () => {
    const { observed, added } = setup();
    const wrap = document.createElement("section");
    wrap.innerHTML = `<p ${ev("x")}></p><span></span>`;
    document.body.append(wrap);
    added(wrap);
    expect(observed).toEqual([wrap.querySelector("p")]);
  });
});
