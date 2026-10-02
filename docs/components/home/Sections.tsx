/**
 * The landing's bands under the hero: stack strip, "Every change is a commit" cards, the
 * stability band, publishing timeline, and "Small on purpose". (The stepper is Stepper.tsx; the
 * final CTA and footer are Footer.tsx; shared pieces are in ui.tsx.)
 */
import type { CSSProperties, ReactNode } from 'react'
import { Icon, Mark, type MarkName } from '~/components/ui/Icon'
import { MdxLink } from '~/components/mdx/MdxLink'
import { Cobogo } from './Hero'
import {
  container,
  d,
  devLink,
  devLinkIcon,
  Dim,
  Dots,
  H2,
  Kicker,
  Lede,
  lsec,
  mono,
  reveal,
  section,
  sectionHead,
  textLink,
  textLinkIcon,
  win,
  winBar,
  winBarSmall,
  winPaper,
  winTitle,
  winTitleSmall,
} from './ui'

const STACK: [MarkName, string][] = [
  ['nextjs', 'Next.js'],
  ['tanstack', 'TanStack Start'],
  ['cloudflare', 'Cloudflare Workers'],
  ['react', 'React Native'],
  ['node', 'Node.js'],
  ['git', 'Any Git repo'],
]

/** A grid of cards separated by 1px hairlines (the gap shows the border colour behind them). */
export const hairlineGrid = 'grid gap-px overflow-hidden border border-border rounded-2xl bg-border'

export function StackStrip() {
  return (
    <div>
      <div className={`${container} pt-18 pb-20 max-sm:py-14`}>
        <Kicker className={`text-center ${reveal}`}>Runs on your stack</Kicker>
        <ul className={`${hairlineGrid} list-none mt-8 p-0 grid-cols-6 max-xl:grid-cols-3 max-md:grid-cols-2 ${reveal}`} style={d('80ms')} aria-label="Runtimes">
          {STACK.map(([mark, label]) => (
            <li
              className="h-24 flex items-center justify-center gap-2.5 px-3 bg-bg text-15 font-medium tracking-snug text-stack-fg text-center transition-colors duration-300 hover:bg-stack-hover hover:text-tint-fg max-md:h-20 max-md:text-14"
              key={mark}
            >
              <Mark name={mark} className="size-[18px] flex-none" />
              {label}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/* "Every change is a commit": the three cards' small window visuals. */
export const ciVisual = 'relative h-[212px] border-hairline rounded-xl overflow-hidden max-home-xl:row-span-3 max-sm:h-[204px]'
export const ciWin = `${win} ${ciVisual}`
export const card = 'min-w-0 pt-6 px-7 pb-9 bg-bg max-home-xl:grid max-home-xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] max-home-xl:gap-x-8 max-home-xl:items-start max-md:block max-sm:pt-4 max-sm:px-4 max-sm:pb-7'
export const cardNum = 'block mt-[30px] text-13 leading-4 tabular-nums text-eyebrow max-home-xl:mt-1 max-md:mt-[26px]'
export const cardH3 = 'mt-2.5 mb-2.5 text-22 leading-tight font-normal tracking-heading'
export const cardP = 'm-0 text-15 leading-[1.6] text-muted-fg'
export const mfRow = 'grid grid-cols-[64px_minmax(0,1fr)] items-center gap-3 py-[9px]'
export const mfLabel = 'text-11.5 leading-4 text-muted-fg'
export const mfInput = 'h-8 flex items-center px-3 border rounded-full bg-surface text-fg min-w-0 whitespace-nowrap overflow-hidden'
export const chip = 'h-[26px] inline-flex items-center px-2.5 rounded-full text-12 leading-4 font-normal'
const aeLine = 'block py-0.5 px-3 text-12 leading-5 whitespace-pre border-0 rounded-none'
const aeIcon = 'size-[13px] text-eyebrow'

export function ContentModel() {
  return (
    <div className={lsec}>
      <div className={`${container} ${section}`}>
        <div className={sectionHead}>
          <Kicker className={reveal}>One content model</Kicker>
          <H2 className={reveal} style={d('60ms')}>
            Every change is a commit, <Dim>whoever makes it.</Dim>
          </H2>
          <Lede className={reveal} style={d('120ms')}>
            Launch a landing page at <code>/summer-sale</code>, schedule a campaign banner, ramp an experiment to 25%: all from a form, all
            reviewable, none of it a code change.
          </Lede>
        </div>
        <div className={`${hairlineGrid} grid-cols-3 max-home-xl:grid-cols-1 ${reveal}`} style={d('160ms')}>
          <div className={card}>
            <div className={`${ciWin} bg-code-bg`} aria-hidden="true" data-pagefind-ignore="">
              <div className={winBarSmall}>
                <Dots small />
                <span className={winTitleSmall}>.deco/index.ts</span>
              </div>
              <pre className="p-4 text-12 leading-[21px]">
                <code>
                  <span className="text-syn-keyword">export default</span>
                  {' {\n  '}
                  <span className="text-syn-property">experiments</span>
                  {',  '}
                  <span className="text-syn-comment italic">// returns A/B flags</span>
                  {'\n  '}
                  <span className="text-syn-property">hero</span>
                  {',         '}
                  <span className="text-syn-comment italic">// returns JSX</span>
                  {'\n  '}
                  <span className="text-syn-property">seo</span>
                  {',          '}
                  <span className="text-syn-comment italic">// returns page metadata</span>
                  {'\n} '}
                  <span className="text-syn-keyword">satisfies</span> <span className="text-syn-type">Blocks</span>;
                </code>
              </pre>
            </div>
            <span className={cardNum}>01</span>
            <h3 className={cardH3}>Headless for developers</h3>
            <p className={cardP}>
              Write a function, type its inputs, and add it to your block map. Content can now call it. Deco Blocks stays out of your stack:
              no database and no content API to run, just JSON files in your repository and a small SDK that works with Next.js, TanStack
              Start, or any JavaScript server.
            </p>
          </div>
          <div className={card}>
            <div className={`${ciWin} bg-surface`} aria-hidden="true" data-pagefind-ignore="">
              <div className={winBarSmall}>
                <Dots small />
                <span className={winTitleSmall}>Studio — Summer campaign</span>
              </div>
              <div className="py-1 px-3.5">
                <div className={mfRow}>
                  <span className={mfLabel}>Name</span>
                  <span className={`${mfInput} border-border text-13`}>Summer campaign</span>
                </div>
                <div className={`${mfRow} border-t border-hairline`}>
                  <span className={mfLabel}>Path</span>
                  <span
                    className={`${mfInput} ${mono} text-12.5 border-olive-ring shadow-[0_0_0_3px_color-mix(in_oklab,var(--brand)_40%,transparent)]`}
                  >
                    /summer-sale
                    <span className="w-px h-4 ml-0.5 bg-fg animate-blink" />
                  </span>
                </div>
                <div className={`${mfRow} border-t border-hairline`}>
                  <span className={mfLabel}>Blocks</span>
                  <span className="flex gap-1.5 flex-wrap">
                    <span className={`${chip} bg-tint font-mono text-tint-fg`}>hero</span>
                    <span className={`${chip} bg-tint font-mono text-tint-fg`}>product</span>
                    <span className={`${chip} bg-transparent border border-dashed border-border-strong text-muted-fg font-sans`}>+ Add</span>
                  </span>
                </div>
              </div>
            </div>
            <span className={cardNum}>02</span>
            <h3 className={cardH3}>Editable for humans</h3>
            <p className={cardP}>
              With the hosted Deco CMS, Studio turns your types into forms and live previews. Marketers and editors
              change pages, campaigns, and settings without a developer, and every change is a commit you can review and roll back.
            </p>
          </div>
          <div className={card}>
            <div
              className={`${ciVisual} border bg-bg-warm p-4 flex flex-col justify-center gap-2.5 max-sm:py-3 max-sm:px-3.5 max-sm:gap-2`}
              aria-hidden="true"
              data-pagefind-ignore=""
            >
              <div className="self-end max-w-[88%] pt-2 px-3.5 pb-[9px] rounded-[14px_14px_4px_14px] bg-hover text-fg text-13 leading-[19px]">
                <span className="block text-10.5 leading-3.5 tracking-label uppercase text-who-fg">You</span>Ramp the new checkout to 25%
              </div>
              <div className="flex-none border border-hairline rounded-xl bg-surface overflow-hidden">
                <div className="flex items-center gap-2 h-8 px-3 border-b border-hairline text-12 leading-4 text-muted-fg whitespace-nowrap overflow-hidden">
                  <Icon name="sparkle" className={aeIcon} />
                  <span className="min-w-0 overflow-hidden text-ellipsis">Edited .deco/blocks/Experiments.json</span>
                </div>
                <code className={`${aeLine} bg-del-bg text-del-fg`}>-  "newCheckout": 10,</code>
                <code className={`${aeLine} bg-add-bg text-fg shadow-[inset_2px_0_0_var(--olive-ring)]`}>+  "newCheckout": 25,</code>
                <div className="flex items-center gap-1.5 h-[30px] px-3 border-t border-hairline text-11.5 leading-4 text-muted-fg whitespace-nowrap overflow-hidden">
                  <Icon name="check" className={aeIcon} />
                  <span>
                    Valid against <b className="font-mono text-11 leading-4 font-normal text-fg">.deco/schema.gen.json</b>
                  </span>
                </div>
              </div>
            </div>
            <span className={cardNum}>03</span>
            <h3 className={cardH3}>Native for AI</h3>
            <p className={cardP}>
              Content is typed JSON in Git, so coding agents read, edit, and validate it with the tools they already have. Their edits arrive
              as ordinary commits your team reviews like anyone else's, and the same types that build the editor keep them honest.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

/* The stability band's status window. */
const pkgTile = 'min-w-0 grid content-start gap-px pt-3 px-3 pb-[13px] border rounded-xl max-home-sm:pt-2.5 max-home-sm:px-2.5 max-home-sm:pb-[11px]'
const pkgStrong = 'text-14.5 leading-5 font-medium tracking-ui max-home-sm:text-13.5'
const pkgSmall = 'text-11.5 leading-[17px] max-home-sm:leading-4'
export const stRow = 'flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 min-h-[52px] py-2.5 px-0.5'
export const stKey = 'text-14 leading-5 text-fg'
export const stPill = 'inline-flex items-center gap-[7px] h-7 pl-2.5 pr-3 rounded-full text-12.5 leading-4 font-medium whitespace-nowrap'
export const stIcon = 'size-[13px]'

export function Stability() {
  return (
    <div className={lsec}>
      <div className="mx-auto w-full max-w-landing px-10 py-8 max-sm:px-2 max-sm:py-4">
        <div className="relative isolate overflow-hidden pt-22 px-18 pb-20 rounded-3xl text-band-fg [background-image:radial-gradient(700px_500px_at_85%_10%,rgba(30,110,55,.5),transparent_60%),linear-gradient(162deg,#145528_0%,#0C4420_50%,#07301A_100%)] max-xl:py-18 max-xl:px-12 max-sm:pt-14 max-sm:px-5 max-sm:pb-12 max-sm:rounded-2xl [&_:where(:focus-visible)]:outline-lime">
          <Cobogo className="top-0 h-full [mask-image:linear-gradient(to_right,transparent_0%,transparent_62%,#000_92%)]" />
          <div className="relative max-w-[900px] mb-[52px]">
            <Kicker band className={reveal}>
              Built for stability
            </Kicker>
            <H2 band className={reveal} style={d('60ms')}>
              Your site ships with its content. <Dim band className="min-home-sm:block">Nothing stands between it and your visitors.</Dim>
            </H2>
            <Lede band className={reveal} style={d('120ms')}>
              Your pages, banners and settings are files in your own repository, and every deploy carries them alongside the code. Your site
              always has the content it needs at hand, so a page never waits on a content server.
            </Lede>
          </div>
          <div className="relative grid grid-cols-[minmax(0,1fr)_minmax(0,1.04fr)] grid-rows-[auto_1fr] gap-x-16 items-start max-xl:gap-x-12 max-nav:grid-cols-1 max-nav:grid-rows-none max-nav:gap-y-10">
            <div
              className={`${win} bg-surface col-[2] row-[1/span_2] rounded-2xl border-[rgba(255,255,255,.14)] shadow-[0_0_0_1px_rgba(0,0,0,.05),0_44px_90px_-34px_rgba(0,0,0,.6)] max-nav:col-[1] max-nav:row-auto ${reveal}`}
              style={d('160ms')}
              role="group"
              aria-labelledby="status-title"
              data-pagefind-ignore=""
            >
              <div className={winBar}>
                <Dots hidden />
                <span className={winTitle} id="status-title">
                  store.example.com — status
                </span>
              </div>
              <div className="pt-[26px] px-[22px] pb-2 max-home-sm:pt-6 max-home-sm:px-3.5 max-home-sm:pb-1.5">
                <div className="relative pt-5 px-3.5 pb-3.5 border-[1.5px] border-dashed border-border-strong rounded-box max-home-sm:px-2.5 max-home-sm:pb-3">
                  <p className="absolute -top-2.5 left-3 m-0 px-2 bg-surface text-12 leading-[18px] tracking-pill uppercase text-eyebrow">
                    Every deploy ships
                  </p>
                  <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-stretch gap-2 max-home-sm:gap-1.5">
                    <div className={`${pkgTile} border-border bg-bg-subtle`}>
                      <Icon name="code" className="size-4 mb-2 text-muted-fg" />
                      <strong className={`${pkgStrong} text-fg`}>Your code</strong>
                      <small className={`${pkgSmall} text-muted-fg`}>Design, features</small>
                    </div>
                    <span
                      className="self-center size-[22px] grid place-items-center rounded-full border border-border bg-surface text-14 leading-none text-muted-fg"
                      aria-hidden="true"
                    >
                      +
                    </span>
                    <div className={`${pkgTile} border-[color-mix(in_oklab,var(--olive-ring)_40%,transparent)] bg-tint`}>
                      <Icon name="file" className="size-4 mb-2 text-tint-fg" />
                      <strong className={`${pkgStrong} text-tint-fg`}>Your content</strong>
                      <small className={`${pkgSmall} text-[color-mix(in_oklab,var(--tint-fg)_78%,transparent)]`}>Pages, banners, settings</small>
                    </div>
                  </div>
                  <p className="mt-3 text-center text-12.5 leading-[18px] text-muted-fg">Packed together, tested together.</p>
                </div>
                <ul className="list-none mt-3.5 p-0" role="list">
                  <li className={stRow}>
                    <span className={stKey}>Your site</span>
                    <span className={`${stPill} bg-pill-on-bg text-pill-on-fg shadow-[inset_0_0_0_1px_var(--pill-on-ring)]`}>
                      <i className="size-[7px] rounded-full flex-none bg-lime shadow-[0_0_0_3px_rgba(208,236,26,.22)]" aria-hidden="true" />
                      Online
                    </span>
                  </li>
                  <li className={`${stRow} border-t border-hairline`}>
                    <span className={stKey}>Content</span>
                    <span className={`${stPill} bg-tint text-tint-fg`}>
                      <Icon name="check" strokeWidth={2.25} className={stIcon} />
                      Inside this deploy
                    </span>
                  </li>
                  <li className={`${stRow} border-t border-hairline`}>
                    <span className={stKey}>Page loads</span>
                    <span className={`${stPill} bg-tint text-tint-fg`}>
                      <Icon name="check" strokeWidth={2.25} className={stIcon} />
                      No extra round trip
                    </span>
                  </li>
                </ul>
              </div>
            </div>
            <ul className={`col-[1] row-[1] list-none m-0 p-0 border-b border-band-line max-nav:row-auto ${reveal}`} style={d('200ms')} role="list">
              <Point title="No content servers to run">No content database or content server to host, scale or keep online.</Point>
              <Point title="Fast on every page">
                Every page is built from content your site already holds, so it loads as fast as your own code.
              </Point>
              <Point title="Stable by design">
                Your site depends on no other service to show its content. Every deploy carries a tested copy of it as the fallback, so what
                visitors see is always a version you shipped or published.
              </Point>
            </ul>
            <MdxLink className={`${devLink} text-lime col-[1] row-[2] max-nav:row-auto max-nav:-mt-1 ${reveal}`} href="/next/releases-and-deployment">
              <span className="font-normal text-band-muted">For developers:</span> how content{' '}
              <span className="whitespace-nowrap">
                loads
                <Icon name="arrow-right" className={devLinkIcon} />
              </span>
            </MdxLink>
          </div>
        </div>
      </div>
    </div>
  )
}

export function Point({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="grid grid-cols-[32px_minmax(0,1fr)] pt-[18px] pb-[19px] border-t border-band-line max-home-sm:grid-cols-[28px_minmax(0,1fr)]">
      <Icon name="check" strokeWidth={2.25} className="size-4 mt-[3px] text-lime" />
      <span className="grid gap-1">
        <strong className="text-16 leading-5.5 font-medium tracking-ui text-white">{title}</strong>
        <span className="text-14.5 leading-[1.55] text-band-muted">{children}</span>
      </span>
    </li>
  )
}

/* The publishing timeline: a 6-column row of step pills per lane, each pill placed in column
   `--c`, linked to the previous one by a dashed connector (::before) and a chevron (::after) that
   span the `--gap`. Below 1000px the lanes sit side by side and each becomes a vertical list. */
const gap = '[--gap:28px] max-home-lg:[--gap:20px] max-home:[--gap:16px]'
export const laneGrid = `${gap} grid grid-cols-6 gap-x-(--gap) max-home:grid-cols-1 max-home:gap-x-0`
export const stepBox =
  'relative min-w-0 flex items-center justify-center border rounded-full text-14 leading-[18px] font-medium tracking-ui text-center max-home-lg:text-13.5 max-home:col-[1] max-home:w-full max-home:max-w-[240px] max-home:justify-self-center max-home-sm:text-13'
export const step = `${stepBox} col-(--c) row-[1] h-10 px-2.5 whitespace-nowrap max-home-lg:px-2 max-home:row-(--c) max-home:h-[38px] max-home:text-13.5 max-home-sm:px-1.5`
export const stepPlain = 'border-border-strong bg-surface text-fg'
export const stepSkip = 'border-dashed border-border-strong bg-transparent text-muted-fg line-through decoration-1'
/** The link from the previous pill (dashed line + chevron, in src/styles/components/home.css). */
export const linked = 'tl-linked'
/** …across a skipped column (Edit → Commit). */
export const linkedFar = 'tl-linked tl-far'
export const lane = 'pt-[26px] px-7 pb-5 max-home-lg:pt-6 max-home-lg:px-[22px] max-home-lg:pb-[18px] max-home:grid max-home:row-span-3 max-home:grid-rows-subgrid max-home:content-start max-home:pt-5 max-home:px-4 max-home:pb-4 max-home-sm:pt-[18px] max-home-sm:px-2.5 max-home-sm:pb-3.5'
const label =
  'flex flex-wrap items-center gap-x-1.5 gap-y-1 mb-6 text-13.5 leading-5 text-muted-fg max-home:items-start max-home:content-start max-home:mb-5 max-home:text-13 max-home-sm:text-12.5 max-home-sm:leading-[18px]'
export const notes = `${laneGrid} mt-2.5 min-h-[30px] text-12.5 leading-[18px] text-muted-fg max-home:mt-3 max-home:min-h-0`
export const bracket =
  'relative col-[4/6] pt-3 text-center before:absolute before:top-0 before:left-[18%] before:right-[18%] before:h-[7px] before:border before:border-t-0 before:border-border-strong before:rounded-b-[7px] max-home:hidden'
export const cap = 'col-[6] justify-self-center pt-3 text-center whitespace-nowrap max-home:col-[1] max-home:pt-0 max-home:whitespace-normal'

export function LaneLabel({ title, sub }: { title: string; sub: string }) {
  return (
    <p className={label}>
      <b className="font-medium text-fg">{title}</b>
      <span className="max-home:hidden">·</span>
      <span className="max-home:basis-full">{sub}</span>
    </p>
  )
}

export function Publishing() {
  return (
    <div className={lsec}>
      <div className={`${container} ${section}`}>
        <div className={sectionHead}>
          <Kicker className={reveal}>Hosted Deco CMS · optional</Kicker>
          <H2 className={reveal} style={d('60ms')}>
            Publish in seconds, <Dim>not on the next deploy.</Dim>
          </H2>
          <Lede className={reveal} style={d('120ms')}>
            The hosted Deco CMS adds Studio and publishing without a redeploy: each change reaches every visitor in
            seconds, and editors preview drafts on your real pages first. Without it, developers and agents edit the files, and content goes
            live with your next deploy.
          </Lede>
        </div>
        <div className={`${winPaper} rounded-2xl ${reveal}`} style={d('160ms')} aria-hidden="true" data-pagefind-ignore="">
          <div className={winBar}>
            <Dots />
            <span className={`${winTitle} max-home-sm:left-16 max-home-sm:right-3.5 max-home-sm:text-right`}>Publishing a change — store.example.com</span>
          </div>
          <div className="max-home:grid max-home:grid-cols-2 max-home:grid-rows-[auto_auto_auto]">
            <div className={lane}>
              <LaneLabel title="Without it" sub="content ships with your next deploy" />
              <ol className={`${laneGrid} list-none m-0 p-0 max-home:grid-rows-[repeat(6,38px)] max-home:gap-y-(--gap) max-home:justify-items-stretch`}>
                <li style={c(1)} className={`${step} ${stepPlain}`}>
                  Edit
                </li>
                <li style={c(3)} className={`${step} ${stepPlain} ${linkedFar}`}>
                  Commit
                </li>
                <li style={c(4)} className={`${step} ${stepPlain} ${linked}`}>
                  Build
                </li>
                <li style={c(5)} className={`${step} ${stepPlain} ${linked}`}>
                  Deploy
                </li>
                <li style={c(6)} className={`${step} ${stepPlain} ${linked}`}>
                  Live
                </li>
              </ol>
              <div className={notes}>
                <span className={bracket}>code release</span>
                <span className={cap}>at your next deploy</span>
              </div>
            </div>
            <div
              className={`${lane} border-t border-hairline bg-[color-mix(in_oklab,var(--tint)_70%,var(--surface))] max-home:border-t-0 max-home:border-l`}
            >
              <LaneLabel title="With the hosted Deco CMS" sub="each publish is a commit" />
              <ol className={`${laneGrid} list-none m-0 p-0 max-home:grid-rows-[repeat(6,38px)] max-home:gap-y-(--gap) max-home:justify-items-stretch`}>
                <li style={c(1)} className={`${step} ${stepPlain}`}>
                  Edit
                </li>
                <li style={c(2)} className={`${step} ${stepPlain} ${linked}`}>
                  Preview
                  <span className="absolute left-1/2 bottom-[calc(100%-9px)] -translate-x-1/2 inline-flex items-center gap-[5px] h-5 px-2 rounded-full bg-pill-on-bg shadow-[inset_0_0_0_1px_var(--pill-on-ring)] text-10.5 leading-3.5 font-medium tracking-normal text-pill-on-fg whitespace-nowrap max-home:hidden">
                    <i className="size-[5px] rounded-full bg-lime" />
                    Previewing a draft
                  </span>
                </li>
                <li style={c(3)} className={`${step} ${stepPlain} ${linked}`}>
                  Publish
                </li>
                <li style={c(4)} className={`${step} ${stepSkip} ${linked} max-home:hidden`}>
                  Build
                </li>
                <li style={c(5)} className={`${step} ${stepSkip} ${linked} max-home:hidden`}>
                  Deploy
                </li>
                {/* Below 1000px, Build and Deploy collapse into this one pill spanning their rows. */}
                <li
                  className={`${stepBox} ${stepSkip} ${linked} hidden max-home:flex max-home:row-[4/6] max-home:self-stretch px-2.5 max-home-lg:px-2 max-home:text-13 max-home:leading-[17px] max-home:no-underline max-home:rounded-[18px] max-home:text-fg max-home-sm:px-1.5`}
                >
                  No build · no deploy
                </li>
                <li style={c(6)} className={`${step} ${linked} border-transparent bg-pub-live-bg text-pub-live-fg shadow-[0_6px_18px_-8px_rgba(7,64,26,.55)]`}>
                  Live everywhere
                </li>
              </ol>
              <div className={notes}>
                <span className={`${bracket} before:border-dashed`}>not needed</span>
                <span className={`${cap} font-medium text-tint-fg`}>in seconds</span>
              </div>
            </div>
          </div>
        </div>
        <ul className={`${hairlineGrid} list-none mt-7 p-0 grid-cols-3 max-home-lg:grid-cols-2 max-home-sm:grid-cols-1 ${reveal}`} style={d('200ms')} role="list">
          <PubPoint title="Not tied to code releases">
            Content needs no build and no deploy, so editors publish when a campaign is ready, not when the next code release goes out.
          </PubPoint>
          <PubPoint title="Preview on the real site">
            Editors open drafts on your actual pages before anything goes live, and only people Studio lets in can see them.
          </PubPoint>
          <PubPoint title="Undo any change">
            Every publish is saved in your repository's history, with who changed what and when, so going back is one step.
          </PubPoint>
        </ul>
        <MdxLink className={`${devLink} text-link ${reveal}`} href="/next/releases-and-deployment">
          <span className="font-normal text-muted-fg">For developers:</span> publishing and{' '}
          <span className="whitespace-nowrap">
            releases
            <Icon name="arrow-right" className={devLinkIcon} />
          </span>
        </MdxLink>
      </div>
    </div>
  )
}

export function PubPoint({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="min-w-0 flex flex-col pt-6 px-[26px] pb-[30px] bg-bg max-home-lg:last:odd:col-span-full max-home-sm:pt-[18px] max-home-sm:px-4 max-home-sm:pb-6">
      <strong className="mb-2 text-19 leading-[1.3] font-normal tracking-[-.012em] text-fg max-home-sm:text-18">{title}</strong>
      <span className="text-14.5 leading-[1.6] text-muted-fg">{children}</span>
    </li>
  )
}

export const c = (n: number) => ({ '--c': n }) as CSSProperties

const HOOD_LINKS: { href: string; title: string; text: string; read: string }[] = [
  {
    href: '/next/blocks',
    title: 'Nothing to export',
    text: 'Content is plain, documented files you already hold: open them in any editor, search them, or generate them with a script.',
    read: 'Read: How a page is built from content',
  },
  {
    href: '/next/how-resolution-works',
    title: 'Small enough to read',
    text: 'Content is plain files and features are ordinary code, so any developer or AI agent can follow how a page is made, with the tools they already use.',
    read: 'Read: How resolution works',
  },
  {
    href: '/next/blocks#blocks-in-your-repository',
    title: 'Publish by committing',
    text: 'Every change is a commit in your repository, with its history and a one-step revert. Add the hosted Deco CMS and a published commit reaches visitors in seconds, with no redeploy.',
    read: 'Read: Blocks in your repository',
  },
  {
    href: '/next/design-decisions',
    title: 'Openly documented',
    text: 'How each part works, and why it was built that way, is written down in these docs, and the source is public on GitHub.',
    read: 'Read: Design decisions',
  },
]

const OWN: [string, string, 'yours' | 'opt'][] = [
  ['Content', 'Your Git repository', 'yours'],
  ['Code', 'Your Git repository', 'yours'],
  ['Hosting', 'Any JavaScript runtime you choose: Node, Cloudflare Workers, Deno, Bun or a React Native app', 'yours'],
  ['Visual editor & publishing without a redeploy', 'Hosted Deco CMS', 'opt'],
]

export const tag = 'h-6 inline-flex items-center px-[11px] rounded-full text-12 leading-4 font-medium whitespace-nowrap'

export function SmallOnPurpose() {
  return (
    <div className={`${lsec} bg-bg-subtle`}>
      <div className={`${container} ${section} grid grid-cols-2 gap-x-20 items-start max-home-lg:gap-x-14 max-nav:grid-cols-1`}>
        <div>
          <Kicker className={reveal}>Yours to keep</Kicker>
          <H2 className={reveal} style={d('60ms')}>
            Small on purpose. <Dim>Nothing hidden.</Dim>
          </H2>
          <Lede className={reveal} style={d('120ms')}>
            Deco Blocks is a small library and a folder of files in your own repository, not a platform you move into. You can read how the
            library works, swap any piece of it, and keep all of your content whatever you decide next.
          </Lede>
          <div className={`mt-10 ${reveal}`} style={d('160ms')}>
            <p className="mb-3 text-14 leading-5 font-medium text-fg" id="own-title">
              Where your site lives
            </p>
            <dl className={`${hairlineGrid} m-0`} aria-labelledby="own-title">
              {OWN.map(([what, where, kind]) => (
                <div
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-5 pt-3.5 px-[18px] pb-[15px] bg-bg max-home-sm:pt-[13px] max-home-sm:px-3.5 max-home-sm:pb-3.5 max-home-sm:gap-x-3"
                  key={what}
                >
                  <dt className="col-[1] text-15 leading-5.5 font-medium tracking-ui text-fg">{what}</dt>
                  <dd className="col-[1] text-14 leading-5 text-muted-fg">{where}</dd>
                  <dd className="col-[2] row-[1/span_2]">
                    {kind === 'yours' ? (
                      <span className={`${tag} bg-tag-yours-bg text-lime`}>Yours</span>
                    ) : (
                      <span className={`${tag} shadow-[inset_0_0_0_1px_var(--border-strong)] text-muted-fg`}>Optional</span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
        <div className="pt-[46px] max-nav:pt-12">
          <div className={`grid border-b border-hairline ${reveal}`} style={d('120ms')}>
            {HOOD_LINKS.map((l) => (
              <MdxLink
                className="group relative grid grid-cols-[minmax(0,1fr)_20px] items-center gap-x-4 gap-y-2 pt-[22px] px-1 pb-6 border-t border-hairline no-underline text-muted-fg text-14.5 leading-[1.6] transition-colors duration-300 max-home-sm:pt-[18px] max-home-sm:px-0 max-home-sm:pb-5"
                href={l.href}
                key={l.href}
              >
                <span className="col-[1] grid gap-0.5 min-w-0">
                  <strong className="text-17 leading-6 font-normal tracking-ui text-fg group-hover:text-link">{l.title}</strong>
                  <span>{l.text}</span>
                  <span className="justify-self-start mt-1.5 text-13 leading-5 text-muted-fg transition-colors duration-300 group-hover:text-link">
                    {l.read}
                  </span>
                </span>
                <Icon
                  name="arrow-right"
                  className="size-[18px] text-olive-ring transition-[translate,color] duration-400 ease-out-quart group-hover:translate-x-1 group-hover:text-eyebrow"
                />
              </MdxLink>
            ))}
          </div>
          <MdxLink className={`${textLink} text-link mt-8 ${reveal}`} href="/next/internals">
            How it works as a whole
            <Icon name="arrow-right" className={textLinkIcon} />
          </MdxLink>
        </div>
      </div>
    </div>
  )
}
