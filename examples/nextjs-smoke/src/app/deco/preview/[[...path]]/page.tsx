import { createDecoPreviewPage } from "@decocms/nextjs";
import { ensureSetup } from "../../../../setup";

export const dynamic = "force-dynamic";

export default createDecoPreviewPage({ setup: ensureSetup });
