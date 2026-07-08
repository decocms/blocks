import { createDecoRouteHandlers } from "@decocms/nextjs/routeHandlers";
import { ensureSetup } from "../../../setup";

export const dynamic = "force-dynamic";

export const { GET, POST } = createDecoRouteHandlers({ setup: ensureSetup });
