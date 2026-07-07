export interface HeroProps {
  label?: string;
}

/**
 * Minimal real section component, registered via `createSiteSetup`'s
 * `sections` map and referenced by the `pages-home` block in `setup.ts`.
 * Its purpose is purely to prove the CMS resolution pipeline resolves and
 * renders real content end-to-end (not a 404) under Next's actual App
 * Router / webpack build — see setup.ts for the block wiring.
 */
export default function Hero({ label }: HeroProps) {
  return <h1 data-testid="hero">{`hero-${label ?? "none"}`}</h1>;
}
