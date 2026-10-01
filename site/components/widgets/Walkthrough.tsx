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
 * Port of the old app.js "Walkthrough" block; markup and classes (.explorer, .trace-*) unchanged.
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

/** The explorer's bare <pre> (no code-panel chrome); `.explorer pre::after` shows data-lang. */
function TracePre({ children, ...props }: ComponentProps<'pre'> & { 'data-lang'?: string }) {
  const lang = props['data-lang'] ?? 'json'
  return (
    <pre aria-label="Resolution example" data-lang={LANG_LABELS[lang] ?? lang}>
      {children}
    </pre>
  )
}

function TraceCodeEl(props: ComponentProps<'code'>) {
  return <code {...props} id="trace-code" />
}

const codeComponents = { TraceCode, pre: TracePre, code: TraceCodeEl }

function Toggle({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={pressed} onClick={onClick}>
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
    <div className="explorer">
      <div className="explorer-top">
        <strong>SummerCard · one saved entry</strong>
        <div className="segmented" role="group" aria-label="CMS call">
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
      <div className="explorer-top">
        <span className="small muted">Function output</span>
        <div className="segmented" role="group" aria-label="Output representation">
          <Toggle pressed={mode === 'data'} onClick={() => setMode('data')}>
            Descriptor
          </Toggle>
          <Toggle pressed={mode === 'rsc'} onClick={() => setMode('rsc')}>
            React tree
          </Toggle>
        </div>
      </div>
      <div className="explorer-body">
        <div className="trace-steps" role="group" aria-label="Resolution steps">
          {STEPS.map((label, i) => (
            <button key={label} type="button" aria-current={i === step ? 'step' : 'false'} disabled={i > last} onClick={() => setStep(i)}>
              {label}
            </button>
          ))}
        </div>
        <ActiveState.Provider value={codeStateFor(step, mode)}>
          <TraceCodeBlocks components={codeComponents} />
        </ActiveState.Provider>
        <p className="trace-caption" id="trace-caption" aria-live="polite">
          {CAPTIONS[operation][step]}
        </p>
        <div className="explorer-footer">
          <span className="trace-stat" id="trace-stat">
            {STATS[operation][step]}
          </span>
          {/* aria-disabled, not disabled: a disabled button drops keyboard focus to <body> on the last step. */}
          <button
            type="button"
            className="primary-button"
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
