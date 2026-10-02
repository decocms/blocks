/**
 * Home (/). The landing, ported from the old landing.html: hero with the Experiments journey,
 * stack strip, "Every change is a commit", stability, publishing, the three-step stepper,
 * "Small on purpose", final CTA and the site footer. Copy is approved as is: keep it verbatim.
 *
 * Styled with Tailwind utilities on the components (shared pieces in ui.tsx; the range sliders'
 * pseudo-elements in src/styles/components/home.css). Entrance motion: `enter` animates on load;
 * `reveal` fades up once on first scroll-in (useReveal), shown at once with prefers-reduced-motion,
 * without IntersectionObserver, and before printing.
 */
import cobogoDefs from '~/assets/cobogo-defs.svg?raw'
import { LandingShell } from '~/src/layout/DocsShell'
import { sidebarFor } from '~/src/lib/nav'
import { DEFAULT_VERSION } from '~/src/lib/versions'
import { Hero } from './Hero'
import { ContentModel, Publishing, SmallOnPurpose, Stability, StackStrip } from './Sections'
import { Stepper } from './Stepper'
import { FinalCta, SiteFooter } from './Footer'
import { useReveal } from './useReveal'

const COBOGO_DEFS = cobogoDefs.trim()

export default function Home() {
  const ref = useReveal<HTMLElement>()
  return (
    <LandingShell nav={sidebarFor(DEFAULT_VERSION, 'docs')} footer={<SiteFooter />}>
      {/* The cobogó <pattern>s (#cb-lg, #cb-sm) that the hero and stability bands fill with. */}
      <span
        className="contents [&>svg]:absolute [&>svg]:size-0 [&>svg]:overflow-hidden [&>svg]:pointer-events-none"
        dangerouslySetInnerHTML={{ __html: COBOGO_DEFS }}
      />
      <section id="home" aria-labelledby="home-title" data-pagefind-body="" ref={ref}>
        <Hero />
        <StackStrip />
        <ContentModel />
        <Stability />
        <Publishing />
        <Stepper />
        <SmallOnPurpose />
        <FinalCta />
      </section>
    </LandingShell>
  )
}
