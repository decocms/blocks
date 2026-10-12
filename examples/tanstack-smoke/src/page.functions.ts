import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { openPage } from "./open-page.server";
import type { BlockDescriptor } from "./model";

export const loadPage = createServerFn({ method: "GET" })
  .inputValidator(z.object({ href: z.string().startsWith("/") }))
  .handler(({ data }) => openPage<BlockDescriptor>(data.href, getRequest()));
