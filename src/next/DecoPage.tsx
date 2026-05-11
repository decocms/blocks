import type { ReactNode } from "react";
import { loadCmsPage } from "./loadCmsPage";

/**
 * Minimal RSC server component that loads a Deco CMS page.
 *
 * Production renderers should provide their own; this is a starting point.
 *
 * Requires consumers to install a Next.js middleware that sets `x-url` and
 * `x-pathname` headers on incoming requests so this component can reconstruct
 * the inbound URL.
 */
export async function DecoPage(): Promise<ReactNode> {
  const { headers } = await import("next/headers");
  const h = await headers();
  const url = new URL(
    h.get("x-url") ?? `http://localhost${h.get("x-pathname") ?? "/"}`,
  );
  const reqHeaders = new Headers();
  h.forEach((value, key) => reqHeaders.set(key, value));
  const req = new Request(url, { headers: reqHeaders });
  const result = await loadCmsPage(req);
  if (!result) return <main>Not Found</main>;
  return (
    <main>
      <pre style={{ display: "none" }}>{JSON.stringify(result, null, 2)}</pre>
    </main>
  );
}
