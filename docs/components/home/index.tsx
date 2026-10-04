/**
 * The home pages, one per docs version: `/` is the current release's (v7/, see v7/index.tsx) and
 * `/next/` the next major's (this folder's Hero, Sections, Stepper, Footer). The routes render the
 * default export with the version (src/routes/index.tsx and src/routes/$version/index.tsx).
 *
 * The next-major landing was ported from the old landing.html: hero with the Experiments journey,
 * stack strip, "Every change is a commit", stability, publishing, the three-step stepper,
 * "Small on purpose", final CTA and the site footer. Its copy is approved as is: keep it verbatim.
 *
 * Styled with Tailwind utilities on the components (shared pieces in ui.tsx; the range sliders'
 * pseudo-elements in src/styles/components/home.css). Entrance motion: `enter` animates on load;
 * `reveal` fades up once on first scroll-in (useReveal), shown at once with prefers-reduced-motion,
 * without IntersectionObserver, and before printing.
 */
import { Icon } from '~/components/ui/Icon'
import { MdxLink } from '~/components/mdx/MdxLink'
import { Hero } from './Hero'
import { ContentModel, Publishing, SmallOnPurpose, Stability, StackStrip } from './Sections'
import { Stepper } from './Stepper'
import { FinalCta, NEXT_COLUMNS } from './Footer'
import { HomeFrame } from './Frame'
import { container, reveal, textLink, textLinkIcon } from './ui'
import { V7Home } from './v7'

/** The next major's link back to the current release's home. */
function CurrentVersionNote() {
  return (
    <div className="border-t border-hairline">
      <div className={`${container} py-10 flex justify-center max-sm:py-8`}>
        <MdxLink className={`${textLink} text-link ${reveal}`} href="/">
          <span className="font-normal text-muted-fg">Using Deco today?</span> See the current version
          <Icon name="arrow-right" className={textLinkIcon} />
        </MdxLink>
      </div>
    </div>
  )
}

function NextHome() {
  return (
    <HomeFrame version="next" columns={NEXT_COLUMNS}>
      <Hero />
      <StackStrip />
      <ContentModel />
      <Stability />
      <Publishing />
      <Stepper />
      <SmallOnPurpose />
      <CurrentVersionNote />
      <FinalCta />
    </HomeFrame>
  )
}

export default function Home({ version }: { version: string }) {
  return version === 'next' ? <NextHome /> : <V7Home />
}
