import { createContext, useContext, useState, type ComponentProps, type ReactNode } from 'react'
import TraceCodeBlocks from './walkthrough-code.mdx'

/**
 * "How resolution works": one saved entry (SummerCard), resolved step by step.
 *
 *   <Walkthrough />
 *
 * Two toggles (the CMS call: `resolve("SummerCard")` or `{ run: false }`; the function output:
 * descriptor or React tree), four step pills, the code at that step, a caption and a call count.
 * It's an illustration: nothing runs. The code for each state is in walkthrough-code.mdx, so it
 * is highlighted at build time like every other code block.
 *
 * Port of the old app.js "Walkthrough" block, styled with Tailwind utilities. It sits inside the
 * article (.doc-section), so the root is `not-prose`; the #trace-* ids are kept.
 */

type Operation = 'resolve' | 'get'
type Mode = 'data' | 'rsc'
type CodeState = 'stored' | 'expanded' | 'children' | 'descriptor' | 'element'

const CAPTIONS: Record<Operation, string[]> = {
  resolve: [
    'The saved entry. Its product input names CurrentProduct, another saved entry.',
    "CurrentProduct is a saved entry, so it's replaced with its JSON, and the rule runs again on what came back.",
    'catalog-product is a function. Its inputs hold no more blocks, so it runs, and the product data takes its place.',
    'product-card is a function. Its inputs are all values now, so it runs. The CMS never looks inside what it returns.',
  ],
  get: [
    'The saved entry. Its product input names CurrentProduct, another saved entry.',
    'Reading without running: saved entries still expand, so CurrentProduct is replaced with its JSON. catalog-product and product-card name functions, so they come back as JSON, untouched. No code runs.',
  ],
}

const STATS: Record<Operation, string[]> = {
  resolve: ['0 function calls', '0 function calls · entry expanded', '1 function call · catalog-product', '2 function calls · result returned as is'],
  get: ['0 function calls', '0 function calls · final value'],
}

const STEPS = ['1 · Stored', '2 · CurrentProduct: saved entry', '3 · catalog-product: function', '4 · product-card: function']

const LANG_LABELS: Record<string, string> = { json: 'JSON', tsx: 'TSX' }

function codeStateFor(step: number, mode: Mode): CodeState {
  if (step === 3) return mode === 'data' ? 'descriptor' : 'element'
  return (['stored', 'expanded', 'children'] as const)[step]
}

const ActiveState = createContext<CodeState>('stored')

/** One state's code block in walkthrough-code.mdx; rendered only while it's the current one. */
function TraceCode({ state, children }: { state: CodeState; children?: ReactNode }) {
  return useContext(ActiveState) === state ? <>{children}</> : null
}

/** The explorer's bare <pre> (no code-panel chrome); its ::after badge shows data-lang. */
function TracePre({ children, ...props }: ComponentProps<'pre'> & { 'data-lang'?: string }) {
  const lang = props['data-lang'] ?? 'json'
  return (
    <pre
      aria-label="Resolution example"
      data-lang={LANG_LABELS[lang] ?? lang}
      className="relative m-0 min-h-54 overflow-auto rounded-xl border border-code-border bg-code-bg px-5.5 py-4.5 after:absolute after:top-3 after:right-3 after:inline-flex after:h-5.5 after:items-center after:rounded-full after:bg-surface after:px-[9px] after:font-sans after:text-11 after:leading-4 after:font-normal after:tracking-pill after:text-muted-fg after:inset-ring after:inset-ring-code-border after:content-[attr(data-lang)] print:min-h-0"
    >
      {children}
    </pre>
  )
}

function TraceCodeEl(props: ComponentProps<'code'>) {
  return <code {...props} id="trace-code" />
}

const codeComponents = { TraceCode, pre: TracePre, code: TraceCodeEl }

/** The pill shapes: the CMS-call/output toggles, and the step pills. */
const PILL = 'rounded-full border border-border text-muted-fg transition-colors'
const ROW = 'flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-4 max-sm:px-3'
const SEGMENTED = 'inline-flex max-w-full flex-wrap gap-1.5 print:hidden'

function Toggle({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`${PILL} h-7.5 bg-transparent px-[13px] font-mono whitespace-nowrap text-12 leading-4 hover:border-olive-ring hover:text-fg aria-pressed:pill-on`}
    >
      {children}
    </button>
  )
}

export function Walkthrough() {
  const [operation, setOperation] = useState<Operation>('resolve')
  const [mode, setMode] = useState<Mode>('data')
  const [rawStep, setStep] = useState(0)
  const last = CAPTIONS[operation].length - 1
  const step = Math.min(rawStep, last)

  return (
    <div className="not-prose my-9 overflow-hidden rounded-2xl border border-hairline bg-surface shadow-win max-sm:rounded-box print:break-inside-avoid-page print:shadow-none">
      {/* Window bar: three dots (one ::before and its two box-shadow copies), then the title. */}
      <div className={`${ROW} bg-win-bar py-3 max-sm:py-2.5`}>
        <strong className="inline-flex items-center text-14 leading-5 font-medium tracking-ui text-fg before:mr-13 before:size-2.5 before:flex-none before:rounded-full before:bg-win-dot before:shadow-[16px_0_0_var(--win-dot),32px_0_0_var(--win-dot)] before:content-[''] max-sm:before:mr-11">
          SummerCard · one saved entry
        </strong>
        <div className={`${SEGMENTED} max-sm:w-full`} role="group" aria-label="CMS call">
          <Toggle
            pressed={operation === 'get'}
            onClick={() => {
              setOperation('get')
              setStep(0)
            }}
          >
            resolve("SummerCard", {'{'} run: false {'}'})
          </Toggle>
          <Toggle
            pressed={operation === 'resolve'}
            onClick={() => {
              setOperation('resolve')
              setStep(0)
            }}
          >
            resolve("SummerCard")
          </Toggle>
        </div>
      </div>
      <div className={`${ROW} bg-surface py-2.5`}>
        <span className="text-13 leading-5.5 text-muted-fg">Function output</span>
        <div className={SEGMENTED} role="group" aria-label="Output representation">
          <Toggle pressed={mode === 'data'} onClick={() => setMode('data')}>
            Descriptor
          </Toggle>
          <Toggle pressed={mode === 'rsc'} onClick={() => setMode('rsc')}>
            React tree
          </Toggle>
        </div>
      </div>
      <div className="p-4.5 max-sm:p-3">
        <div className="mb-4 flex flex-wrap gap-1.5 print:hidden" role="group" aria-label="Resolution steps">
          {STEPS.map((label, i) => (
            <button
              key={label}
              type="button"
              aria-current={i === step ? 'step' : 'false'}
              disabled={i > last}
              onClick={() => setStep(i)}
              className={`${PILL} h-8 bg-surface px-3.5 text-13 leading-5 enabled:hover:border-olive-ring enabled:hover:text-fg disabled:cursor-default disabled:opacity-45 aria-[current=step]:pill-on`}
            >
              {label}
            </button>
          ))}
        </div>
        <ActiveState.Provider value={codeStateFor(step, mode)}>
          <TraceCodeBlocks components={codeComponents} />
        </ActiveState.Provider>
        <p className="my-4 min-h-14 text-15 leading-6 text-muted-fg" id="trace-caption" aria-live="polite">
          {CAPTIONS[operation][step]}
        </p>
        <div className="flex items-center justify-between gap-3 border-t border-hairline pt-4">
          <span
            className="inline-flex items-center gap-2 font-mono text-12 leading-4 text-muted-fg before:size-[7px] before:flex-none before:rounded-full before:bg-brand before:shadow-[0_0_0_1px_var(--indicator-ring)] before:content-['']"
            id="trace-stat"
          >
            {STATS[operation][step]}
          </span>
          {/* aria-disabled, not disabled: a disabled button drops keyboard focus to <body> on the last step. */}
          <button
            type="button"
            className="inline-flex h-10 items-center gap-2 rounded-full bg-brand px-5 text-14 leading-5 font-medium text-brand-ink transition-[background-color,scale] ease-out-quart not-aria-disabled:hover:bg-brand-hover not-aria-disabled:active:scale-97 aria-disabled:cursor-default aria-disabled:opacity-45 print:hidden"
            id="trace-next"
            aria-disabled={step === last}
            onClick={() => step < last && setStep(step + 1)}
          >
            Next step →
          </button>
        </div>
      </div>
    </div>
  )
}
