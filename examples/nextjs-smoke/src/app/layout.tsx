import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Deco example", description: "A Deco CMS site on the Next.js App Router." };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
