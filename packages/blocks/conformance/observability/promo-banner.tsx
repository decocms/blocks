// The docs' PromoBanner (telemetry.mdx › Your own tracing), as a block function.
export interface PromoBannerProps {
  title: string;
  href: string;
}

export function PromoBanner({ title, href }: PromoBannerProps) {
  return <a href={href}>{title}</a>;
}
