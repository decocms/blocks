/**
 * The hero's product window: the four-pane "Experiments" journey (Type it → Edit it → Commit it →
 * Resolve it). Dragging a Studio slider rewrites the JSON diff, the commit status and the odds in
 * the last pane (#exp-odds); Save "commits" the change. Below 768px the panes become a
 * scroll-snap carousel driven by (and driving) the step pills under the window.
 */
import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { Icon } from '~/components/ui/Icon'
import { BrandSymbol } from '~/components/ui/Brand'
import { MdxLink } from '~/components/mdx/MdxLink'
import { prefersReducedMotion, toast } from '~/src/lib/ui'
import { Ck, Cm, F, K, L, N, P, S, T } from './tokens'
import { Dots, enter, mono, symbol, textLink, textLinkIcon, win, winBarDark, winTitle } from './ui'

type Key = 'newCheckout' | 'stickyHeader' | 'freeShippingBanner'
type Values = Record<Key, number>

const KEYS: Key[] = ['newCheckout', 'stickyHeader', 'freeShippingBanner']
const FIELDS: Record<Key, string> = {
  newCheckout: 'New checkout flow',
  stickyHeader: 'Sticky header',
  freeShippingBanner: 'Free shipping banner',
}
const LABELS: Record<Key, string> = {
  newCheckout: 'new checkout',
  stickyHeader: 'sticky header',
  freeShippingBanner: 'free shipping banner',
}
/** What's committed on main when the page loads, and what the Studio form shows. */
const INITIAL_SAVED: Values = { newCheckout: 10, stickyHeader: 50, freeShippingBanner: 0 }
const INITIAL_VALUES: Values = { newCheckout: 25, stickyHeader: 50, freeShippingBanner: 0 }

function commitMessage(saved: Values, values: Values) {
  const changed = KEYS.filter((k) => values[k] !== saved[k])
  if (changed.length === 1) {
    const k = changed[0]
    return `${values[k] > saved[k] ? 'ramp ' : 'lower '}${LABELS[k]} to ${values[k]}%`
  }
  return changed.length ? `update ${changed.length} experiments` : ''
}

const Arrow = () => (
  <span
    className="absolute z-2 top-1/2 -right-[18px] size-[26px] -mt-[13px] grid place-items-center rounded-full bg-win-panel border border-border text-eyebrow shadow-sm max-rail:hidden"
    aria-hidden="true"
  >
    <Icon name="chevron-right" className="size-3.5" />
  </span>
)

/* The four panes. `jp` is the hook the phone carousel queries. */
const pane = 'jp relative min-w-0 flex flex-col border border-hairline rounded-xl bg-win-panel max-md:snap-start'
const head = 'flex items-center gap-2 h-[42px] px-3.5 border-b border-hairline'
const stepNum = 'text-12 leading-4 tabular-nums text-eyebrow'
const title = 'text-13.5 leading-5 font-medium text-fg tracking-ui whitespace-nowrap'
const meta = 'ml-auto min-w-0 font-mono text-11 leading-4 font-normal text-muted-fg overflow-hidden text-ellipsis whitespace-nowrap'
/* The panes sit on the mock's light surface, so a scrolling pane's focus ring is the olive ring,
   not the lime one the Hero gives its other descendants. */
const pre = 'flex-1 m-0 pb-3.5 overflow-x-auto text-10.5 leading-[18px] text-code-fg scrollbar-none focus-visible:outline-ring'
/** A numbered pane: no left padding, the line numbers' hairline drawn as a scrolling background. */
const preLn = `${pre} pt-3 pl-0 pr-2 [counter-reset:ln] [background:linear-gradient(to_right,transparent_21px,var(--hairline)_21px,var(--hairline)_22px,transparent_22px)_local]`
const foot = 'flex items-center gap-2 min-h-[42px] px-3.5 py-2.5 border-t border-hairline text-11.5 leading-4 text-muted-fg'
const footText = 'min-w-0 overflow-hidden text-ellipsis whitespace-nowrap'
const footMono = `${mono} text-10.5 whitespace-nowrap overflow-hidden text-ellipsis`
const footIcon = 'size-3.5 text-eyebrow'
/* Diff lines of the JSON pane. */
const dl = 'block -mx-3.5 pl-2 pr-3.5 whitespace-pre'
const gut = 'inline-block w-3 select-none'
const source = 'inline-flex items-center gap-1.5 h-6 pl-2 pr-2.5 border border-border rounded-full bg-surface text-fg whitespace-nowrap'

const STEPS = ['Type', 'Edit', 'Commit', 'Resolve']

export function Journey() {
  const [saved, setSaved] = useState<Values>(INITIAL_SAVED)
  const [values, setValues] = useState<Values>(INITIAL_VALUES)
  const [lastCommit, setLastCommit] = useState('')
  const [flashKey, setFlashKey] = useState<Key | null>(null)
  const [step, setStep] = useState(0)
  const journeyRef = useRef<HTMLDivElement>(null)
  const footRef = useRef<HTMLDivElement>(null)

  const changed = KEYS.filter((k) => values[k] !== saved[k]).length
  const state = changed ? 'dirty' : lastCommit ? 'committed' : 'clean'
  const status = changed ? `${changed}${changed === 1 ? ' change' : ' changes'} · not committed yet` : lastCommit ? 'Committed' : 'No changes'
  const commitLine = changed ? commitMessage(saved, values) : lastCommit || 'up to date with main'

  const save = () => {
    const message = commitMessage(saved, values)
    if (!message) return
    setLastCommit(message)
    setSaved({ ...values })
    setFlashKey(null)
    const foot = footRef.current
    if (foot) {
      foot.classList.remove('just')
      void foot.offsetWidth
      foot.classList.add('just')
    }
    toast('In Studio, Save commits the file to your repository.')
  }

  /* ---- phone carousel: the pills follow the scroll position and drive it ---- */
  const panels = () => Array.from(journeyRef.current?.querySelectorAll<HTMLElement>('.jp') ?? [])
  const showPanel = useCallback((i: number) => {
    const journey = journeyRef.current
    const panel = panels()[i]
    if (!journey || !panel) return
    const pad = parseFloat(getComputedStyle(journey).paddingLeft) || 0
    journey.scrollTo({ left: panel.offsetLeft - pad, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
    setStep(i)
  }, [])

  useEffect(() => {
    const journey = journeyRef.current
    if (!journey) return
    let tick = false
    const onScroll = () => {
      if (tick) return
      tick = true
      requestAnimationFrame(() => {
        tick = false
        const left = journey.scrollLeft
        const pad = parseFloat(getComputedStyle(journey).paddingLeft) || 0
        let best = 0
        let dist = Infinity
        panels().forEach((p, i) => {
          const d = Math.abs(p.offsetLeft - pad - left)
          if (d < dist) {
            dist = d
            best = i
          }
        })
        if (journey.scrollLeft + journey.clientWidth >= journey.scrollWidth - 2) best = panels().length - 1
        setStep(best)
      })
    }
    const onFocusIn = (event: FocusEvent) => {
      if (journey.scrollWidth <= journey.clientWidth + 1) return
      const list = panels()
      const i = list.findIndex((p) => p.contains(event.target as Node))
      if (i < 0) return
      const box = journey.getBoundingClientRect()
      const r = list[i].getBoundingClientRect()
      if (r.left < box.left - 1 || r.right > box.right + 1) showPanel(i)
    }
    journey.addEventListener('scroll', onScroll, { passive: true })
    journey.addEventListener('focusin', onFocusIn)
    return () => {
      journey.removeEventListener('scroll', onScroll)
      journey.removeEventListener('focusin', onFocusIn)
    }
  }, [showPanel])

  const prop = (k: Key, v: number, comma: string, del?: boolean) => (
    <>
      {'  '}
      <P>"{k}"</P>: <N className={del ? 'line-through decoration-[color-mix(in_oklab,var(--del-fg)_60%,transparent)]' : undefined}>{v}</N>
      {comma}
    </>
  )

  return (
    <>
      <div
        className={`${win} mt-16 rounded-2xl bg-win-bg border-[rgba(255,255,255,.12)] shadow-[0_0_0_1px_rgba(255,255,255,.06),0_50px_120px_-40px_rgba(0,0,0,.6)] max-sm:mt-11 max-sm:rounded-box ${enter}`}
        data-pagefind-ignore=""
        style={{ '--d': '420ms' } as CSSProperties}
      >
        <div className={winBarDark}>
          <Dots hidden />
          <span className={`${winTitle} max-sm:left-16 max-sm:right-4 max-sm:text-right`}>Deco Blocks · my-store — Experiments</span>
        </div>
        <div
          className="relative grid grid-cols-4 gap-2.5 p-2.5 max-rail:grid-cols-2 max-md:grid-cols-none max-md:grid-flow-col max-md:auto-cols-[86%] max-md:overflow-x-auto max-md:snap-x max-md:snap-mandatory max-md:scroll-px-2.5 max-md:overscroll-x-contain max-md:scrollbar-none"
          role="group"
          aria-label="From a TypeScript type to a resolved value"
          ref={journeyRef}
        >
          <div className={pane}>
            <div className={head}>
              <span className={stepNum}>01</span>
              <span className={title}>Type it</span>
              <span className={meta}>experiments.ts</span>
            </div>
            <pre className={preLn}>
              <code className="block">
                <L>
                  <K>export</K> <K>interface</K> <T>Experiments</T> {'{'}
                </L>
                <L>
                  {'  '}
                  <Cm>
                    /** <Ck>@title</Ck> New checkout flow
                  </Cm>
                </L>
                <L>
                  <Cm>
                    {'   *  '}
                    <Ck>@minimum</Ck> 0 <Ck>@maximum</Ck> 100 */
                  </Cm>
                </L>
                <L>
                  {'  '}
                  <P>newCheckout</P>: <T>number</T>;
                </L>
                <L>
                  {'  '}
                  <Cm>
                    /** <Ck>@title</Ck> Sticky header … */
                  </Cm>
                </L>
                <L>
                  {'  '}
                  <P>stickyHeader</P>: <T>number</T>;
                </L>
                <L>
                  {'  '}
                  <Cm>
                    /** <Ck>@title</Ck> Free shipping … */
                  </Cm>
                </L>
                <L>
                  {'  '}
                  <P>freeShippingBanner</P>: <T>number</T>;
                </L>
                <L>{'}'}</L>
              </code>
            </pre>
            <div className={foot}>
              <span className={footMono}>npx deco schema</span>
              <span className={`${footText} text-eyebrow`} aria-hidden="true">
                →
              </span>
              <span className={footMono}>.deco/schema.json</span>
            </div>
            <Arrow />
          </div>

          <div className={pane}>
            <div className={head}>
              <span className={stepNum}>02</span>
              <span className={title}>Edit it</span>
              <span className={meta}>Deco Studio</span>
            </div>
            <div className="flex-1 flex flex-col bg-st-bg text-st-fg rounded-b-[11px]">
              <div className="flex items-center justify-between gap-2 h-[42px] px-3.5 border-b border-st-border">
                <span className={`inline-flex items-center gap-2 text-13 leading-5 font-medium ${symbol}`}>
                  <BrandSymbol />
                  Experiments
                </span>
                <span className="font-mono text-11 leading-4 font-normal text-st-muted px-2 py-0.5 rounded-full bg-st-field border border-st-border">
                  experiments
                </span>
              </div>
              {KEYS.map((k, i) => (
                <div className={i ? 'mt-2 pt-3 px-3.5 pb-0.5 border-t border-st-border' : 'pt-2.5 px-3.5 pb-0.5'} key={k}>
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-12 leading-4 text-st-muted" htmlFor={`exp-${k}`}>
                      {FIELDS[k]}
                    </label>
                    <output
                      className="min-w-[38px] h-[22px] inline-grid place-items-center px-2 rounded-full bg-tint font-mono text-11 leading-4 font-medium tabular-nums text-tint-fg"
                      id={`out-${k}`}
                      htmlFor={`exp-${k}`}
                    >
                      {values[k]}
                    </output>
                  </div>
                  <input
                    type="range"
                    className="home-range block w-full h-5 mt-1.5 bg-transparent cursor-pointer focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 focus-visible:rounded-sm"
                    id={`exp-${k}`}
                    min={0}
                    max={100}
                    value={values[k]}
                    data-exp={k}
                    style={{ '--val': `${values[k]}%` } as CSSProperties}
                    onChange={(e) => {
                      setValues((v) => ({ ...v, [k]: Number(e.target.value) }))
                      setFlashKey(k)
                    }}
                  />
                </div>
              ))}
              <div className="mt-auto flex items-center justify-between gap-2 px-3.5 py-2.5 border-t border-st-border">
                <span className="text-11 leading-4 text-st-muted">0–100, from the JSDoc tags</span>
                <button
                  type="button"
                  className="h-[30px] min-w-16 px-4 border-0 rounded-full bg-brand text-brand-ink text-12.5 font-medium transition-[background-color,color,scale] focus-visible:outline-ring enabled:hover:bg-brand-hover enabled:active:scale-[.96] disabled:bg-st-field disabled:text-st-muted disabled:shadow-[inset_0_0_0_1px_var(--st-border)] disabled:cursor-default"
                  id="studio-save"
                  disabled={!changed}
                  onClick={save}
                >
                  {changed ? 'Save' : 'Saved'}
                </button>
              </div>
            </div>
            <Arrow />
          </div>

          <div className={pane}>
            <div className={head}>
              <span className={stepNum}>03</span>
              <span className={title}>Commit it</span>
              <span className={meta} title=".deco/blocks/Experiments.json">
                <span className="rail:hidden max-xs:hidden">.deco/blocks/</span>Experiments.json
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 pt-2.5 px-3.5 text-11 leading-4 text-muted-fg">
              <span className={source}>
                <i className="size-1.5 rounded-full bg-purple" aria-hidden="true" />
                Saved in Studio
              </span>
              <span>or</span>
              <span className={source}>
                <i className="size-1.5 rounded-full bg-yellow" aria-hidden="true" />
                Edited by an agent
              </span>
            </div>
            <pre className={`${pre} pt-2.5 pl-3 pr-2.5`} aria-label="Diff of .deco/blocks/Experiments.json">
              <code className="block" id="exp-json">
                <span className={dl}>
                  <span className={`${gut} text-faint`}> </span>
                  {'{'}
                </span>
                <span className={dl}>
                  <span className={`${gut} text-faint`}> </span>
                  {'  '}
                  <P>"__resolveType"</P>: <S>"experiments"</S>,
                </span>
                {KEYS.map((k, i) => {
                  const comma = i < KEYS.length - 1 ? ',' : ''
                  if (values[k] === saved[k])
                    return (
                      <span className={dl} key={k}>
                        <span className={`${gut} text-faint`}> </span>
                        {prop(k, values[k], comma)}
                      </span>
                    )
                  return (
                    <Fragment key={k}>
                      <span className={`${dl} bg-del-bg`}>
                        <span className={`${gut} text-del-fg`}>-</span>
                        {prop(k, saved[k], comma, true)}
                      </span>
                      {/* Keyed by value so each change remounts the line and the flash replays. */}
                      <span
                        className={`${dl} bg-add-bg shadow-[inset_2px_0_0_var(--olive-ring)]${k === flashKey ? ' animate-flash' : ''}`}
                        key={`${k}-${values[k]}`}
                      >
                        <span className={`${gut} text-eyebrow`}>+</span>
                        {prop(k, values[k], comma)}
                      </span>
                    </Fragment>
                  )
                })}
                <span className={dl}>
                  <span className={`${gut} text-faint`}> </span>
                  {'}'}
                </span>
              </code>
            </pre>
            {/* The commit status: data-state (dirty | committed | clean) switches its children; save()
                toggles `.just` here (the className stays constant, so React never drops it). */}
            <div className={`group ${foot} [&.just]:animate-commit-in`} id="exp-foot" data-state={state} aria-live="polite" ref={footRef}>
              <span
                className={`${footText} size-[7px] rounded-full bg-yellow shadow-[0_0_0_3px_rgba(255,193,22,.2)] flex-none group-data-[state=committed]:hidden group-data-[state=clean]:bg-faint group-data-[state=clean]:shadow-none`}
                aria-hidden="true"
              />
              <Icon name="check" className={`${footIcon} hidden group-data-[state=committed]:block`} />
              <span
                className={`${footText} flex-none text-fg font-medium group-data-[state=committed]:absolute group-data-[state=committed]:size-px group-data-[state=committed]:[clip-path:inset(50%)]`}
                id="exp-status"
              >
                {status}
              </span>
              <span
                className={`${footMono} hidden group-data-[state=committed]:block group-data-[state=committed]:min-w-0 group-data-[state=committed]:text-11 group-data-[state=committed]:text-fg`}
                id="exp-commit"
              >
                {commitLine}
              </span>
            </div>
            <Arrow />
          </div>

          <div className={pane}>
            <div className={head}>
              <span className={stepNum}>04</span>
              <span className={title}>Resolve it</span>
              <span className={meta}>checkout.ts</span>
            </div>
            <pre className={preLn}>
              <code className="block">
                <L>
                  <K>import</K> {'{ createCMS } '}
                  <K>from</K>
                </L>
                <L>
                  {'  '}
                  <S>"@decocms/blocks"</S>;
                </L>
                <L>
                  <K>import</K> experiments <K>from</K>
                </L>
                <L>
                  {'  '}
                  <S>"./experiments"</S>;
                </L>
                <L>
                  <K>import</K> content <K>from</K>
                </L>
                <L>
                  {'  '}
                  <S>"./.deco/blocks.gen"</S>;
                </L>
                <L>
                  <K>const</K> cms = <F>createCMS</F>({'{'}
                </L>
                <L>{'  blocks: { experiments },'}</L>
                <L>{'  content,'}</L>
                <L>{'});'}</L>
                <L>
                  <K>const</K> [flags, error] = <K>await</K> cms
                </L>
                <L>
                  {'  .'}
                  <F>forRelease</F>()
                </L>
                <L>
                  {'  .'}
                  <F>resolve</F>(<S>"Experiments"</S>);
                </L>
                <L>
                  <K>if</K> (error) <K>throw</K> error;
                </L>
                <L>
                  <Cm>
                    // true on ~<span id="exp-odds">{values.newCheckout}</span>% of calls
                  </Cm>
                </L>
              </code>
            </pre>
            <div className={foot}>
              <Icon name="check" className={footIcon} />
              <span className={footText}>Same result as the direct call, same type</span>
            </div>
          </div>
        </div>
      </div>
      <div
        className={`hidden max-md:flex justify-center flex-wrap gap-1.5 mt-4 ${enter}`}
        data-pagefind-ignore=""
        style={{ '--d': '480ms' } as CSSProperties}
        role="group"
        aria-label="Steps in the product window"
      >
        {STEPS.map((label, i) => (
          <button
            type="button"
            className="group h-[30px] inline-flex items-center gap-1.5 px-3 border border-[rgba(255,255,255,.22)] rounded-full bg-transparent text-[rgba(255,255,255,.78)] text-13 leading-4 transition-[background-color,color,border-color] duration-300 aria-[current=step]:bg-[rgba(255,255,255,.2)] aria-[current=step]:border-transparent aria-[current=step]:text-white"
            data-jp={i}
            aria-current={i === step ? 'step' : undefined}
            key={label}
            onClick={() => showPanel(i)}
          >
            <span className="tabular-nums text-[rgba(255,255,255,.5)] group-aria-[current=step]:text-lime" aria-hidden="true">{`0${i + 1}`}</span>
            {label}
          </button>
        ))}
      </div>
      <div className={`flex items-baseline justify-between gap-6 mt-7 max-md:block max-md:mt-5 ${enter}`} style={{ '--d': '520ms' } as CSSProperties}>
        <p className="m-0 max-w-[78ch] text-14 leading-5.5 text-band-muted">
          The Quickstart, end to end. Studio saves it, or an agent edits it: either way it's a commit, and the function never changes.{' '}
          <span className="text-white font-medium">Drag a slider, then Save.</span>
        </p>
        <MdxLink className={`${textLink} text-brand max-md:mt-3.5`} href="/next/quickstart">
          Follow the quickstart
          <Icon name="arrow-right" className={textLinkIcon} />
        </MdxLink>
      </div>
    </>
  )
}
