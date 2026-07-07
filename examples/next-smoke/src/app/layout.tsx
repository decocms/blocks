import { DecoRootLayout } from "@decocms/next";
import "../setup";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <DecoRootLayout siteName="next-smoke-fixture">{children}</DecoRootLayout>;
}
