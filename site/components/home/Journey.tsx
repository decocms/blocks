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
  <span className="jp-arrow" aria-hidden="true">
    <Icon name="chevron-right" />
  </span>
)

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

  const prop = (k: Key, v: number, comma: string) => (
    <>
      {'  '}
      <P>"{k}"</P>: <N>{v}</N>
      {comma}
    </>
  )

  return (
    <>
      <div className="hero-window win enter" data-pagefind-ignore="" style={{ '--d': '420ms' } as CSSProperties}>
        <div className="win-bar">
          <span className="win-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="win-title">Deco Blocks · my-store — Experiments</span>
        </div>
        <div className="journey" role="group" aria-label="From a TypeScript type to a resolved value" ref={journeyRef}>
          <div className="jp jp-type">
            <div className="jp-head">
              <span className="jp-step">01</span>
              <span className="jp-title">Type it</span>
              <span className="jp-meta">experiments.ts</span>
            </div>
            <pre className="jp-pre has-ln">
              <code>
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
            <div className="jp-foot">
              <span className="mono">npx deco schema</span>
              <span className="jp-foot-sep" aria-hidden="true">
                →
              </span>
              <span className="mono">.deco/schema.json</span>
            </div>
            <Arrow />
          </div>

          <div className="jp jp-form">
            <div className="jp-head">
              <span className="jp-step">02</span>
              <span className="jp-title">Edit it</span>
              <span className="jp-meta">Deco Studio</span>
            </div>
            <div className="studio">
              <div className="studio-bar">
                <span className="studio-block">
                  <BrandSymbol />
                  Experiments
                </span>
                <span className="studio-type">experiments</span>
              </div>
              {KEYS.map((k) => (
                <div className="studio-field" key={k}>
                  <div className="studio-row">
                    <label htmlFor={`exp-${k}`}>{FIELDS[k]}</label>
                    <output id={`out-${k}`} htmlFor={`exp-${k}`}>
                      {values[k]}
                    </output>
                  </div>
                  <input
                    type="range"
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
              <div className="studio-actions">
                <span className="studio-hint">0–100, from the JSDoc tags</span>
                <button type="button" className="studio-save" id="studio-save" disabled={!changed} onClick={save}>
                  {changed ? 'Save' : 'Saved'}
                </button>
              </div>
            </div>
            <Arrow />
          </div>

          <div className="jp jp-json">
            <div className="jp-head">
              <span className="jp-step">03</span>
              <span className="jp-title">Commit it</span>
              <span className="jp-meta" title=".deco/blocks/Experiments.json">
                <span className="jm-dir">.deco/blocks/</span>Experiments.json
              </span>
            </div>
            <div className="jp-src">
              <span className="src src-studio">
                <i aria-hidden="true" />
                Saved in Studio
              </span>
              <span className="src-or">or</span>
              <span className="src src-agent">
                <i aria-hidden="true" />
                Edited by an agent
              </span>
            </div>
            <pre className="jp-pre jp-diff" aria-label="Diff of .deco/blocks/Experiments.json">
              <code id="exp-json">
                <span className="dl">
                  <span className="gut"> </span>
                  {'{'}
                </span>
                <span className="dl">
                  <span className="gut"> </span>
                  {'  '}
                  <P>"__resolveType"</P>: <S>"experiments"</S>,
                </span>
                {KEYS.map((k, i) => {
                  const comma = i < KEYS.length - 1 ? ',' : ''
                  if (values[k] === saved[k])
                    return (
                      <span className="dl" key={k}>
                        <span className="gut"> </span>
                        {prop(k, values[k], comma)}
                      </span>
                    )
                  return (
                    <Fragment key={k}>
                      <span className="dl del">
                        <span className="gut">-</span>
                        {prop(k, saved[k], comma)}
                      </span>
                      {/* Keyed by value so each change remounts the line and the flash replays. */}
                      <span className={`dl add${k === flashKey ? ' flash' : ''}`} key={`${k}-${values[k]}`}>
                        <span className="gut">+</span>
                        {prop(k, values[k], comma)}
                      </span>
                    </Fragment>
                  )
                })}
                <span className="dl">
                  <span className="gut"> </span>
                  {'}'}
                </span>
              </code>
            </pre>
            <div className="jp-foot jp-commit" id="exp-foot" data-state={state} aria-live="polite" ref={footRef}>
              <span className="jc-dot" aria-hidden="true" />
              <Icon name="check" />
              <span className="jc-status" id="exp-status">
                {status}
              </span>
              <span className="mono jc-msg" id="exp-commit">
                {commitLine}
              </span>
            </div>
            <Arrow />
          </div>

          <div className="jp jp-call">
            <div className="jp-head">
              <span className="jp-step">04</span>
              <span className="jp-title">Resolve it</span>
              <span className="jp-meta">checkout.ts</span>
            </div>
            <pre className="jp-pre has-ln">
              <code>
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
            <div className="jp-foot">
              <Icon name="check" />
              <span>Same result as the direct call, same type</span>
            </div>
          </div>
        </div>
      </div>
      <div className="journey-nav enter" data-pagefind-ignore="" style={{ '--d': '480ms' } as CSSProperties} role="group" aria-label="Steps in the product window">
        {STEPS.map((label, i) => (
          <button type="button" data-jp={i} aria-current={i === step ? 'step' : undefined} key={label} onClick={() => showPanel(i)}>
            <span aria-hidden="true">{`0${i + 1}`}</span>
            {label}
          </button>
        ))}
      </div>
      <div className="journey-caption enter" style={{ '--d': '520ms' } as CSSProperties}>
        <p>
          The Quickstart, end to end. Studio saves it, or an agent edits it: either way it's a commit, and the function never changes.{' '}
          <span className="try">Drag a slider, then Save.</span>
        </p>
        <MdxLink className="text-link" href="/next/quickstart">
          Follow the quickstart
          <Icon name="arrow-right" />
        </MdxLink>
      </div>
    </>
  )
}
