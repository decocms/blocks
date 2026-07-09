import { DecoRootLayout } from "@decocms/nextjs";
import { ensureSetup } from "../setup";

// `createNextSetup` (unlike the old `createSiteSetup`/`createAdminSetup`
// pair this replaced) does NOT bootstrap the site as a module-load side
// effect — it returns a memoized `ensureSetup` that must be awaited before
// any CMS resolution runs. The admin catch-all route
// (`app/deco/[[...deco]]/route.ts`) awaits it itself via
// `createDecoRouteHandlers({ setup: ensureSetup })`, but the page-render
// path (`app/[[...slug]]/page.tsx` → `createDecoPage`) has no such hook, so
// the root layout — the one server component every page route shares —
// awaits it here instead.
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await ensureSetup();
  return <DecoRootLayout siteName="next-smoke-fixture">{children}</DecoRootLayout>;
}
