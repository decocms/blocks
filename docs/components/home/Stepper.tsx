/**
 * "Three steps, no ticket" (#home-how): a vertical tablist (arrows/Home/End move and select) that
 * switches the setup window's panes; the window's file tabs select too.
 */
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Icon } from '~/components/ui/Icon'
import { BrandSymbol } from '~/components/ui/Brand'
import { container, d, Dim, Dots, H2, Kicker, Lede, lsec, reveal, section, symbol, winBar, winPaper, winTitle } from './ui'
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
  { icon: 'file' as const, label: '.deco/blocks.ts' },
  { icon: 'terminal' as const, label: 'Terminal' },
  { icon: 'file' as const, label: 'cms.ts' },
]

const FORM_ROWS: [string, number][] = [
  ['New checkout flow', 10],
  ['Sticky header', 50],
  ['Free shipping banner', 0],
]

/** The pane's code, as the old page rendered it (frozen Prism markup; see tokens.tsx). */
export function Code({ html }: { html: string }) {
  return (
    <pre
      data-lang="TypeScript"
      data-label="TypeScript"
      className="language-typescript flex-1 m-0 py-[22px] px-6 overflow-auto text-13 leading-5.5 bg-code-bg focus-visible:outline-offset-[-2px] max-sm:p-4 max-sm:text-12 max-sm:leading-5"
      tabIndex={0}
    >
      <code className="language-typescript" dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  )
}

export const fileTab =
  'inline-flex items-center gap-1.5 h-[30px] px-[13px] border rounded-full font-mono text-12 leading-4 font-normal whitespace-nowrap cursor-pointer transition-[color,background-color,border-color] max-xs:px-[11px]'
const fileTabOff = `${fileTab} border-border text-muted-fg hover:text-fg hover:border-olive-ring`
const fileTabOn = `${fileTab} pill-on`
const paneOff =
  'col-start-1 row-start-1 min-w-0 flex flex-col invisible opacity-0 translate-y-1.5 [transition:opacity_.3s_ease,translate_.4s_var(--ease-out-quart),visibility_0s_linear_.3s]'
const paneOn = 'col-start-1 row-start-1 min-w-0 flex flex-col visible opacity-100 [transition:opacity_.45s_ease,translate_.6s_var(--ease-out-expo)]'

export function Result({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2.5 mt-auto py-3.5 px-5 border-t border-hairline bg-tint text-14 leading-5 text-tint-fg flex-none max-sm:py-3 max-sm:px-4 max-sm:text-13.5 [&_code]:text-[.86em] [&_code]:bg-result-code-bg">
      <Icon name="check" strokeWidth={2.5} className="size-5 p-1 rounded-full bg-result-icon-bg text-result-icon-fg flex-none" />
      {children}
    </p>
  )
}

export interface StepperStep {
  title: string
  text: ReactNode
}

/**
 * The stepper's frame, shared by both homes: kicker, sticky heading and lede, the vertical tablist,
 * and the setup window with its file tabs. `panes` are the window's panes, one per step (wrapped
 * here in the tabpanels).
 */
export function StepperShell({
  kicker,
  title,
  lede,
  steps,
  fileTabs,
  windowTitle,
  panes,
  titleClassName = 'max-w-[15ch] max-lg:max-w-none',
}: {
  kicker: ReactNode
  title: ReactNode
  lede: ReactNode
  steps: StepperStep[]
  fileTabs: { icon: 'file' | 'terminal' | 'eye'; label: string }[]
  windowTitle: string
  panes: ReactNode[]
  titleClassName?: string
}) {
  const [step, setStep] = useState(1)
  const tabs = useRef<(HTMLButtonElement | null)[]>([])

  const select = (n: number, focus?: boolean) => {
    setStep(n)
    if (focus) tabs.current[n - 1]?.focus()
  }
  const onKey = (i: number) => (event: KeyboardEvent) => {
    const k = event.key
    const len = steps.length
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
    className: step === n ? paneOn : paneOff,
    id: `step-pane-${n}`,
    role: 'tabpanel',
    'aria-labelledby': `step-tab-${n}`,
  })
  return (
    <div className={lsec} id="home-how">
      <div className={`${container} ${section}`}>
        <Kicker className={reveal}>{kicker}</Kicker>
        <div className="grid grid-cols-[minmax(0,.85fr)_minmax(0,1.15fr)] gap-14 items-start mt-11 max-lg:grid-cols-1 max-lg:gap-10">
          <div className="sticky top-[calc(var(--header-h)+48px)] max-lg:static">
            <H2 className={`${titleClassName} ${reveal}`} style={d('60ms')}>
              {title}
            </H2>
            <Lede className={reveal} style={d('120ms')}>
              {lede}
            </Lede>
            <div
              className={`flex flex-col mt-8 border-b border-hairline ${reveal}`}
              style={d('160ms')}
              role="tablist"
              aria-label="Three steps"
              aria-orientation="vertical"
            >
              {steps.map((s, i) => {
                const n = i + 1
                const on = step === n
                return (
                  <button
                    key={n}
                    ref={(el) => {
                      tabs.current[i] = el
                    }}
                    className="group relative grid grid-cols-[16px_minmax(0,1fr)] gap-x-5 w-full py-4 border-t border-hairline rounded-none bg-transparent text-inherit text-left transition-colors duration-300 before:absolute before:left-0 before:-top-px before:h-0.5 before:w-0 before:bg-nav-bar before:transition-[width] before:duration-600 before:ease-out-expo aria-selected:before:w-full"
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
                    <span
                      className="pt-px text-13 leading-5.5 tabular-nums text-num-faint transition-colors duration-300 group-hover:text-fg group-aria-selected:text-step-on"
                      aria-hidden="true"
                    >
                      {`0${n}`}
                    </span>
                    <span>
                      <span className="block text-15 leading-5.5 font-normal tracking-ui text-fg transition-colors duration-300 group-aria-selected:font-medium">
                        {s.title}
                      </span>
                      <span className="grid grid-rows-[0fr] mt-0 text-14 leading-[1.55] text-muted-fg opacity-0 [transition:grid-template-rows_.5s_var(--ease-out-quart),margin-top_.5s_var(--ease-out-quart),opacity_.4s_ease] group-aria-selected:grid-rows-[1fr] group-aria-selected:mt-1.5 group-aria-selected:opacity-100">
                        <span className="min-h-0 overflow-hidden">{s.text}</span>
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
          <div className={`${winPaper} flex flex-col min-w-0 min-h-[468px] rounded-none max-sm:min-h-0 ${reveal}`} style={d('140ms')} data-pagefind-ignore="">
            <div className={winBar}>
              <Dots hidden />
              <span className={`${winTitle} max-sm:left-16 max-sm:right-3 max-sm:text-right`}>{windowTitle}</span>
            </div>
            <div
              className="flex flex-wrap gap-1.5 py-2.5 px-4 border-b border-hairline flex-none max-sm:px-3 max-xs:flex-nowrap max-xs:overflow-x-auto max-xs:scrollbar-none"
              aria-hidden="true"
            >
              {fileTabs.map((t, i) => (
                <span className={step === i + 1 ? fileTabOn : fileTabOff} data-step={i + 1} key={t.label} onClick={() => select(i + 1)}>
                  <Icon name={t.icon} className="size-[13px] max-xs:hidden" />
                  {t.label}
                </span>
              ))}
            </div>
            <div className="flex-1 grid">
              {panes.map((p, i) => (
                <div {...pane(i + 1)} key={i}>
                  {p}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export function Stepper() {
  return (
    <StepperShell
      kicker="Three steps, no ticket"
      title={
        <>
          Your function stays. <Dim>Its inputs move into a file.</Dim>
        </>
      }
      lede="No rewrite and no new runtime. Name the function in a block map, generate a form from its types, and connect your app to your content with one call."
      steps={STEPS}
      fileTabs={FILE_TABS}
      windowTitle="Deco Blocks · my-store — setup"
      panes={[
        <>
          <Code html={STEP1_HTML} />
          <Result>
            <span>
              The key <code>experiments</code> is now a block type content can refer to.
            </span>
          </Result>
        </>,
        <>
          <div className="flex gap-3 mt-[22px] mx-6 py-[13px] px-[18px] rounded-full bg-term-bg font-mono text-13 leading-5 font-normal text-[#EAF3D6] overflow-x-auto whitespace-nowrap scrollbar-none max-sm:mt-4 max-sm:mx-4 max-sm:text-12 max-sm:rounded-xl">
            <span className="text-brand font-medium" aria-hidden="true">
              $
            </span>
            <span>npx deco schema &amp;&amp; npx deco content</span>
          </div>
          <div
            className="flex-none mt-4 mx-6 mb-[22px] border border-st-border rounded-xl bg-st-bg text-st-fg overflow-hidden max-sm:mt-3 max-sm:mx-4 max-sm:mb-4"
            role="group"
            aria-label="The form Studio builds from the schema"
          >
            <div className={`flex items-center gap-2 h-10 px-3.5 border-b border-st-border bg-bg-subtle text-13 font-medium ${symbol}`}>
              <BrandSymbol />
              <span>Experiments</span>
              <span className="ml-auto px-2 py-0.5 border border-st-border rounded-full bg-st-bg font-mono text-11 leading-4 font-normal text-st-muted">
                experiments
              </span>
            </div>
            {FORM_ROWS.map(([label, n], i) => (
              <div
                className={`grid grid-cols-[minmax(0,1fr)_72px_48px] items-center gap-3 h-[46px] px-3.5 text-13 max-sm:grid-cols-[minmax(0,1fr)_56px] ${i ? 'border-t border-st-border' : ''}`}
                key={label}
              >
                <span>{label}</span>
                <span className="h-7 flex items-center justify-end px-3 border border-st-border rounded-full bg-st-field font-mono text-12 leading-4 font-medium tabular-nums">
                  {n}
                </span>
                <span className="font-mono text-11 leading-4 font-normal text-st-muted text-right max-sm:hidden">0–100</span>
              </div>
            ))}
          </div>
          <Result>
            <span>Studio shows each experiment as a number field clamped to 0–100.</span>
          </Result>
        </>,
        <>
          <Code html={STEP3_HTML} />
          <Result>
            <span>
              With the hosted Deco CMS (the site and token above), a commit is live everywhere within seconds, no deploy. Without it, content ships
              with each deploy.
            </span>
          </Result>
        </>,
      ]}
    />
  )
}
