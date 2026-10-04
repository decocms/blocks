/**
 * The current release's hero: headline, CTAs, the install pill and the "From a section to a live
 * page" window (Write it → Edit it → Store it → Serve it). Typing a headline in the Studio pane
 * rewrites the JSON diff and the rendered page; Publish takes the change as the new baseline.
 * Below 768px the panes become the same scroll-snap carousel as the next major's hero.
 */
import { useState, type CSSProperties } from 'react'
import { Icon } from '~/components/ui/Icon'
import { BrandSymbol } from '~/components/ui/Brand'
import { MdxLink } from '~/components/mdx/MdxLink'
import { toast } from '~/src/lib/ui'
import { Cobogo, cobogoEdges, heroBand, heroTitle, InstallButton } from '../Hero'
import {
  Arrow,
  dl,
  foot,
  footIcon,
  footMono,
  footText,
  gut,
  head,
  JourneyPills,
  meta,
  pane,
  pre,
  preLn,
  stepNum,
  title,
  useJourneyCarousel,
} from '../Journey'
import { Cm, Ck, K, L, P, S, T } from '../tokens'
import { btnPrimary, btnWhite, container, cta, d, Dots, enter, symbol, textLink, textLinkIcon, win, winBarDark, winTitle } from '../ui'

const INSTALL = 'bun add @decocms/blocks @decocms/blocks-admin @decocms/tanstack'

export function V7Hero() {
  return (
    <div className={heroBand}>
      <Cobogo className={`top-[120px] h-[calc(100%-120px)] max-nav:top-[88px] max-nav:h-[calc(100%-88px)] ${cobogoEdges}`} />
      <div className={container}>
        <h1 id="home-title" className={`${heroTitle} ${enter}`} style={d('60ms')}>
          Sections in code.
          <br /> Pages in Studio.
          <br /> <span className="text-[rgba(255,255,255,.52)]">Live on your stack.</span>
        </h1>
        <p className={`mt-5 max-w-[600px] text-15 leading-[1.6] text-band-muted ${enter}`} style={d('120ms')}>
          Deco Blocks is the framework behind Deco sites and storefronts. Developers write React sections in TypeScript. Editors compose
          pages, banners and campaigns in Deco Studio, the visual editor. Your site serves them from TanStack Start on Cloudflare Workers or
          from Next.js, with commerce apps for VTEX, Shopify and more.
        </p>
        <div className={`${cta} ${enter}`} style={d('300ms')}>
          <MdxLink className={btnPrimary} href="/v7/quickstart">
            Start with TanStack Start
          </MdxLink>
          <MdxLink className={btnWhite} href="/v7/quickstart-nextjs">
            Use Next.js
          </MdxLink>
          <InstallButton command={INSTALL} />
        </div>
      </div>
      <div className={container}>
        <SectionJourney />
      </div>
    </div>
  )
}

const SAVED = 'Spring collection'
const STEPS = ['Write', 'Edit', 'Store', 'Serve']

/** Escapes a value for display inside a JSON string. */
const jsonText = (v: string) => JSON.stringify(v).slice(1, -1)

const field = 'pt-2.5 px-3.5'
const fieldLabel = 'block text-12 leading-4 text-st-muted'
const fieldBox =
  'mt-1.5 h-8 w-full flex items-center px-3 border border-st-border rounded-full bg-st-field text-12.5 leading-4 text-st-fg min-w-0 overflow-hidden text-ellipsis whitespace-nowrap'

function SectionJourney() {
  const [saved, setSaved] = useState(SAVED)
  const [headline, setHeadline] = useState('Summer sale')
  const { journeyRef, step, showPanel } = useJourneyCarousel()
  const changed = headline !== saved
  const shown = headline.trim() || 'Your headline'

  const publish = () => {
    if (!changed) return
    setSaved(headline)
    toast("Published. Studio sent the change to your site's /.decofile endpoint.")
  }

  return (
    <>
      <div
        className={`${win} mt-16 rounded-2xl bg-win-bg border-[rgba(255,255,255,.12)] shadow-[0_0_0_1px_rgba(255,255,255,.06),0_50px_120px_-40px_rgba(0,0,0,.6)] max-sm:mt-11 max-sm:rounded-box ${enter}`}
        data-pagefind-ignore=""
        style={{ '--d': '420ms' } as CSSProperties}
      >
        <div className={winBarDark}>
          <Dots hidden />
          <span className={`${winTitle} max-sm:left-16 max-sm:right-4 max-sm:text-right`}>Deco Blocks · my-store — Home page</span>
        </div>
        <div
          className="relative grid grid-cols-4 gap-2.5 p-2.5 max-rail:grid-cols-2 max-md:grid-cols-none max-md:grid-flow-col max-md:auto-cols-[86%] max-md:overflow-x-auto max-md:snap-x max-md:snap-mandatory max-md:scroll-px-2.5 max-md:overscroll-x-contain max-md:scrollbar-none"
          role="group"
          aria-label="From a section to a live page"
          ref={journeyRef}
        >
          {/* 01 · the section's code */}
          <div className={pane}>
            <div className={head}>
              <span className={stepNum}>01</span>
              <span className={title}>Write it</span>
              <span className={meta} title="src/sections/Hero.tsx">
                <span className="rail:hidden max-xs:hidden">src/sections/</span>Hero.tsx
              </span>
            </div>
            <pre className={preLn}>
              <code className="block">
                <L>
                  <K>export</K> <K>interface</K> <T>Props</T> {'{'}
                </L>
                <L>
                  {'  '}
                  <Cm>
                    /** <Ck>@title</Ck> Headline */
                  </Cm>
                </L>
                <L>
                  {'  '}
                  <P>title</P>: <T>string</T>;
                </L>
                <L>
                  {'  '}
                  <Cm>
                    /** <Ck>@title</Ck> Background image */
                  </Cm>
                </L>
                <L>
                  {'  '}
                  <P>image</P>: <T>ImageWidget</T>;
                </L>
                <L>
                  {'  '}
                  <P>cta</P>?: {'{ '}
                  <P>label</P>: <T>string</T>;
                </L>
                <L>
                  {'    '}
                  <P>href</P>: <T>string</T> {'};'}
                </L>
                <L>{'}'}</L>
                <L> </L>
                <L>
                  <K>export default function</K> <T>Hero</T>(
                </L>
                <L>
                  {'  { '}
                  <P>title</P>, <P>image</P>, <P>cta</P> {'}: '}
                  <T>Props</T>
                </L>
                <L>) {'{ … }'}</L>
              </code>
            </pre>
            <div className={foot}>
              <span className={footMono}>bun run generate</span>
              <span className={`${footText} text-eyebrow`} aria-hidden="true">
                →
              </span>
              <span className={footMono}>a form in Studio</span>
            </div>
            <Arrow />
          </div>

          {/* 02 · Studio's form, generated from Props; the headline is live */}
          <div className={pane}>
            <div className={head}>
              <span className={stepNum}>02</span>
              <span className={title}>Edit it</span>
              <span className={meta}>Studio — Home page</span>
            </div>
            <div className="flex-1 flex flex-col bg-st-bg text-st-fg rounded-b-[11px]">
              <div className="flex items-center justify-between gap-2 h-[42px] px-3.5 border-b border-st-border">
                <span className={`inline-flex items-center gap-2 text-13 leading-5 font-medium ${symbol}`}>
                  <BrandSymbol />
                  Hero
                </span>
                <span className="font-mono text-11 leading-4 font-normal text-st-muted px-2 py-0.5 rounded-full bg-st-field border border-st-border">
                  sections/Hero.tsx
                </span>
              </div>
              <div className={field}>
                <label className={fieldLabel} htmlFor="v7-headline">
                  Headline
                </label>
                <input
                  id="v7-headline"
                  type="text"
                  value={headline}
                  maxLength={40}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => setHeadline(e.target.value)}
                  className={`${fieldBox} outline-none border-olive-ring shadow-[0_0_0_3px_color-mix(in_oklab,var(--brand)_40%,transparent)] focus-visible:shadow-[0_0_0_3px_color-mix(in_oklab,var(--brand)_70%,transparent)]`}
                />
              </div>
              <div className={field}>
                <span className={fieldLabel}>Background image</span>
                <span className={`${fieldBox} gap-2 pl-1`}>
                  <i className="size-6 flex-none rounded-full bg-[linear-gradient(135deg,#F2C14E,#E07A3F_55%,#2F6F4F)]" aria-hidden="true" />
                  summer.jpg
                </span>
              </div>
              <div className={`${field} grid grid-cols-2 gap-2`}>
                <span className="min-w-0">
                  <span className={fieldLabel}>CTA label</span>
                  <span className={fieldBox}>Shop now</span>
                </span>
                <span className="min-w-0">
                  <span className={fieldLabel}>CTA link</span>
                  <span className={`${fieldBox} font-mono text-11.5`}>/summer</span>
                </span>
              </div>
              <div className="mt-auto pt-3 flex items-center justify-between gap-2 px-3.5 py-2.5 border-t border-st-border">
                <span className="text-11 leading-4 text-st-muted">Fields from the Props type</span>
                <button
                  type="button"
                  className="h-[30px] min-w-16 px-4 border-0 rounded-full bg-brand text-brand-ink text-12.5 font-medium transition-[background-color,color,scale] focus-visible:outline-ring enabled:hover:bg-brand-hover enabled:active:scale-[.96] disabled:bg-st-field disabled:text-st-muted disabled:shadow-[inset_0_0_0_1px_var(--st-border)] disabled:cursor-default"
                  disabled={!changed}
                  onClick={publish}
                >
                  {changed ? 'Publish' : 'Published'}
                </button>
              </div>
            </div>
            <Arrow />
          </div>

          {/* 03 · the page block in the decofile */}
          <div className={pane}>
            <div className={head}>
              <span className={stepNum}>03</span>
              <span className={title}>Store it</span>
              <span className={meta} title=".deco/blocks/pages-home.json">
                <span className="rail:hidden max-xs:hidden">.deco/blocks/</span>pages-home.json
              </span>
            </div>
            <pre className={`${pre} pt-3 pl-3 pr-2.5`} aria-label="Diff of .deco/blocks/pages-home.json">
              <code className="block">
                <span className={dl}>
                  <span className={`${gut} text-faint`}> </span>
                  {'{ '}
                  <P>"path"</P>: <S>"/"</S>,
                </span>
                <span className={dl}>
                  <span className={`${gut} text-faint`}> </span>
                  {'  '}
                  <P>"sections"</P>: [{'{'}
                </span>
                <span className={dl}>
                  <span className={`${gut} text-faint`}> </span>
                  {'    '}
                  <P>"__resolveType"</P>:
                </span>
                <span className={dl}>
                  <span className={`${gut} text-faint`}> </span>
                  {'      '}
                  <S>"site/sections/Hero.tsx"</S>,
                </span>
                {changed ? (
                  <>
                    <span className={`${dl} bg-del-bg`}>
                      <span className={`${gut} text-del-fg`}>-</span>
                      {'    '}
                      <P>"title"</P>: <S className="line-through decoration-[color-mix(in_oklab,var(--del-fg)_60%,transparent)]">"{jsonText(saved)}"</S>,
                    </span>
                    <span className={`${dl} bg-add-bg shadow-[inset_2px_0_0_var(--olive-ring)]`}>
                      <span className={`${gut} text-eyebrow`}>+</span>
                      {'    '}
                      <P>"title"</P>: <S>"{jsonText(headline)}"</S>,
                    </span>
                  </>
                ) : (
                  <span className={dl}>
                    <span className={`${gut} text-faint`}> </span>
                    {'    '}
                    <P>"title"</P>: <S>"{jsonText(saved)}"</S>,
                  </span>
                )}
                <span className={dl}>
                  <span className={`${gut} text-faint`}> </span>
                  {'    '}
                  <P>"image"</P>: <S>"…/summer.jpg"</S>
                </span>
                <span className={dl}>
                  <span className={`${gut} text-faint`}> </span>
                  {'  }]'}
                </span>
                <span className={dl}>
                  <span className={`${gut} text-faint`}> </span>
                  {'}'}
                </span>
              </code>
            </pre>
            <div className={`${foot} flex-wrap gap-y-1`} aria-live="polite">
              <span
                className={`size-[7px] rounded-full flex-none ${changed ? 'bg-yellow shadow-[0_0_0_3px_rgba(255,193,22,.2)]' : 'bg-faint'}`}
                aria-hidden="true"
              />
              <span className={`${footText} whitespace-normal`}>
                {changed ? 'Publish → live in seconds with Fast Deploy · or with your next deploy' : 'Published · no changes'}
              </span>
            </div>
            <Arrow />
          </div>

          {/* 04 · the rendered page */}
          <div className={pane}>
            <div className={head}>
              <span className={stepNum}>04</span>
              <span className={title}>Serve it</span>
              <span className={meta}>store.example.com</span>
            </div>
            <div className="flex-1 flex flex-col gap-2.5 p-3">
              <div className="flex items-center gap-1.5 h-6 px-2.5 rounded-full border border-hairline bg-surface text-10.5 leading-4 text-muted-fg">
                <Icon name="lock" className="size-3 flex-none" />
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">store.example.com</span>
              </div>
              <div className="relative overflow-hidden rounded-lg px-3.5 pt-6 pb-4 min-h-[118px] flex flex-col justify-end bg-[linear-gradient(135deg,#F2C14E_0%,#E07A3F_48%,#2F6F4F_100%)] text-white">
                <span className="block text-17 leading-tight font-medium tracking-heading [text-shadow:0_1px_8px_rgba(0,0,0,.25)] break-words">{shown}</span>
                <span className="mt-2.5 self-start inline-flex items-center h-6 px-3 rounded-full bg-white text-[#282524] text-11 leading-4 font-medium">
                  Shop now
                </span>
              </div>
              <div className="rounded-lg border border-dashed border-border-strong p-2.5">
                <div className="grid grid-cols-3 gap-1.5" aria-hidden="true">
                  {[0, 1, 2].map((i) => (
                    <span className="block h-11 rounded-md bg-muted motion-safe:animate-pulse" key={i} />
                  ))}
                </div>
                <p className="mt-2 text-10.5 leading-4 text-muted-fg">Deferred section · loads as you scroll</p>
              </div>
            </div>
            <div className={foot}>
              <Icon name="check" className={footIcon} />
              <span className={footText}>Rendered by your own code</span>
            </div>
          </div>
        </div>
      </div>
      <JourneyPills steps={STEPS} step={step} onSelect={showPanel} />
      <div className={`flex items-baseline justify-between gap-6 mt-7 max-md:block max-md:mt-5 ${enter}`} style={{ '--d': '520ms' } as CSSProperties}>
        <p className="m-0 max-w-[78ch] text-14 leading-5.5 text-band-muted">
          A section is a typed React component. Studio builds its form, the page is saved as JSON, and your site renders it.{' '}
          <span className="text-white font-medium">Type a new headline.</span>
        </p>
        <MdxLink className={`${textLink} text-brand max-md:mt-3.5`} href="/v7/quickstart">
          Follow the quickstart
          <Icon name="arrow-right" className={textLinkIcon} />
        </MdxLink>
      </div>
    </>
  )
}
