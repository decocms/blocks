import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import PreviewProviders from "./PreviewProviders";

// A section that reads React Query at render time — the exact shape that made
// the /live/previews in-place render throw "No QueryClient set" for commerce
// sections (e.g. Carousel.tsx) before PreviewProviders provided a client.
function SectionUsingQuery() {
  const { data } = useQuery({ queryKey: ["preview-probe"], queryFn: () => "loaded" });
  return <div data-testid="section">{data ?? "loading"}</div>;
}

function SectionUsingRouter() {
  const router = useRouter();
  return <div data-testid="router">{router ? "has-router" : "no-router"}</div>;
}

describe("PreviewProviders", () => {
  it("renders a section that calls useQuery without throwing", () => {
    const html = renderToString(
      <PreviewProviders>
        <SectionUsingQuery />
      </PreviewProviders>,
    );
    // No QueryClient error, and the section renders its pending state (static
    // preview render — the query never resolves during renderToString).
    expect(html).toContain("loading");
    expect(html).not.toContain("No QueryClient");
  });

  it("still provides the TanStack Router context", () => {
    const html = renderToString(
      <PreviewProviders>
        <SectionUsingRouter />
      </PreviewProviders>,
    );
    expect(html).toContain("has-router");
  });
});
