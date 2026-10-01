/**
 * "Three steps, no ticket" (#home-how): a vertical tablist (arrows/Home/End move and select) that
 * switches the setup window's panes; the window's file tabs select too.
 */
import { useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from '~/components/ui/Icon'
import { BrandSymbol } from '~/components/ui/Brand'
import { d } from './Hero'
import { STEP1_HTML, STEP3_HTML } from './tokens'

const STEPS = [
  {
    title: 'Write a function',
    text: 'Write a function, type its inputs, and add it to your block map. Content can now call it: a hero banner, a product feed, an A/B test split. Nothing to learn, nothing to install in the function itself.',
  },
  {
    title: 'It becomes editable',
    text: "One command turns the function's types into a form. With the hosted Deco CMS, that's the form editors use in Deco Studio, so marketing can change copy, images and campaigns without waiting on a developer.",
  },
  {
    title: 'Ship from Git',
    text: 'Every change is a commit you can review like code. Add the hosted Deco CMS to preview drafts on your real pages and publish without a deploy.',
  },
]

const FILE_TABS = [
  { icon: 'file' as const, label: 'blocks.ts' },
  { icon: 'terminal' as const, label: 'Terminal' },
  { icon: 'file' as const, label: 'cms.ts' },
]

const FORM_ROWS: [string, number][] = [
  ['New checkout flow', 10],
  ['Sticky header', 50],
  ['Free shipping banner', 0],
]

/** The pane's code, as the old page rendered it (Prism markup; see tokens.tsx). */
function Code({ html }: { html: string }) {
  return (
    <pre data-lang="TypeScript" data-label="TypeScript" className="language-typescript" tabIndex={0}>
      <code className="language-typescript" dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  )
}

export function Stepper() {
  const [step, setStep] = useState(1)
  const tabs = useRef<(HTMLButtonElement | null)[]>([])

  const select = (n: number, focus?: boolean) => {
    setStep(n)
    if (focus) tabs.current[n - 1]?.focus()
  }
  const onKey = (i: number) => (event: KeyboardEvent) => {
    const k = event.key
    const len = STEPS.length
    let to: number | null = null
    if (k === 'ArrowDown' || k === 'ArrowRight') to = (i + 1) % len
    else if (k === 'ArrowUp' || k === 'ArrowLeft') to = (i - 1 + len) % len
    else if (k === 'Home') to = 0
    else if (k === 'End') to = len - 1
    if (to !== null) {
      event.preventDefault()
      select(to + 1, true)
    }
  }
  const pane = (n: number) => ({
    className: `sw-pane${step === n ? ' is-on' : ''}`,
    id: `step-pane-${n}`,
    role: 'tabpanel',
    'aria-labelledby': `step-tab-${n}`,
  })

  return (
    <div className="lsec" id="home-how">
      <div className="container section">
        <p className="kicker reveal">Three steps, no ticket</p>
        <div className="stepper">
          <div className="stepper-copy">
            <h2 className="reveal" style={d('60ms')}>
              Your function stays. <span className="dim">Its inputs move into a file.</span>
            </h2>
            <p className="section-lede reveal" style={d('120ms')}>
              No rewrite and no new runtime. Name the function in a block map, generate a form from its types, and connect your app to your
              content with one call.
            </p>
            <div className="steps reveal" style={d('160ms')} role="tablist" aria-label="Three steps" aria-orientation="vertical">
              {STEPS.map((s, i) => {
                const n = i + 1
                const on = step === n
                return (
                  <button
                    key={n}
                    ref={(el) => {
                      tabs.current[i] = el
                    }}
                    className="step"
                    type="button"
                    role="tab"
                    id={`step-tab-${n}`}
                    aria-controls={`step-pane-${n}`}
                    aria-selected={on}
                    tabIndex={on ? 0 : -1}
                    data-step={n}
                    onClick={() => select(n)}
                    onKeyDown={onKey(i)}
                  >
                    <span className="num" aria-hidden="true">
                      {`0${n}`}
                    </span>
                    <span className="step-body">
                      <span className="step-title">{s.title}</span>
                      <span className="step-text">
                        <span>{s.text}</span>
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
          <div className="sw win reveal" style={d('140ms')} data-pagefind-ignore="">
            <div className="win-bar">
              <span className="win-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span className="win-title">Deco Blocks · my-store — setup</span>
            </div>
            <div className="sw-tabs" aria-hidden="true">
              {FILE_TABS.map((t, i) => (
                <span className={`sw-tab${step === i + 1 ? ' is-on' : ''}`} data-step={i + 1} key={t.label} onClick={() => select(i + 1)}>
                  <Icon name={t.icon} />
                  {t.label}
                </span>
              ))}
            </div>
            <div className="sw-panes">
              <div {...pane(1)}>
                <Code html={STEP1_HTML} />
                <p className="sw-result">
                  <Icon name="check" />
                  <span>
                    The key <code>experiments</code> is now a block type content can refer to.
                  </span>
                </p>
              </div>
              <div {...pane(2)}>
                <div className="sw-term">
                  <span className="sw-prompt" aria-hidden="true">
                    $
                  </span>
                  <span>npx deco schema &amp;&amp; npx deco content</span>
                </div>
                <div className="sw-form" role="group" aria-label="The form Studio builds from the schema">
                  <div className="swf-head">
                    <BrandSymbol />
                    <span>Experiments</span>
                    <span className="swf-type">experiments</span>
                  </div>
                  {FORM_ROWS.map(([label, n]) => (
                    <div className="swf-row" key={label}>
                      <span>{label}</span>
                      <span className="swf-num">{n}</span>
                      <span className="swf-range">0–100</span>
                    </div>
                  ))}
                </div>
                <p className="sw-result">
                  <Icon name="check" />
                  <span>Studio shows each experiment as a number field clamped to 0–100.</span>
                </p>
              </div>
              <div {...pane(3)}>
                <Code html={STEP3_HTML} />
                <p className="sw-result">
                  <Icon name="check" />
                  <span>
                    With the hosted Deco CMS (the token above), a commit is live everywhere in seconds, no deploy. Without it, content ships
                    with each deploy.
                  </span>
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
