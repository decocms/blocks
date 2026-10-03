// analytics.mdx › Render the script, verbatim (app/layout.tsx).
import { AnalyticsScript } from "@decocms/blocks/analytics";
import { cms } from "./cms";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [analytics] = await cms.forRelease().resolve("Analytics");   // the settings, defaults filled in

  return (
    <html lang="en">
      <body>
        {children}
        <AnalyticsScript {...analytics} />
      </body>
    </html>
  );
}
