import type { PromoBannerProps } from "./model";

export default function PromoBanner({ title, href }: PromoBannerProps) {
  return (
    <a href={href} role="note">
      {title}
    </a>
  );
}
