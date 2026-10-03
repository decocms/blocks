import { Suspense, type ReactNode } from "react";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { z } from "zod";
import { openPage } from "./open-page.server";

async function BlockSlot({ value }: { value: Promise<{ value?: ReactNode; failed: boolean }> }) {
  const { value: node, failed } = await value;
  if (failed) return <p role="status">This content is temporarily unavailable.</p>;
  return node ?? null;   // undefined when an editor hid the block: render nothing
}

export const loadPage = createServerFn({ method: "GET" })
  .inputValidator(z.object({ href: z.string().startsWith("/") }))
  .handler(async ({ data }) => {
    const page = await openPage<ReactNode>(data.href, getRequest());
    const content = await renderServerComponent(
      <main>
        {page.blocks.map((block) => (
          <Suspense key={block.key} fallback={<p>Loading…</p>}>
            <BlockSlot value={block.value} />
          </Suspense>
        ))}
      </main>,
    );
    return { seo: page.seo, content };
  });
