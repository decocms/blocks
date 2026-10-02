/**
 * "From zero to an editable page": the current release's three steps, in the stepper frame both
 * homes share (../Stepper.tsx).
 */
import { BrandSymbol } from '~/components/ui/Brand'
import { Code, Result, StepperShell, type StepperStep } from '../Stepper'
import { Dim, symbol } from '../ui'
import { HERO_TSX_HTML } from './tokens'

const STEPS: StepperStep[] = [
  {
    title: 'Write a section.',
    text: (
      <>
        A React component and its <code>Props</code> type, with JSDoc labels for the form.
      </>
    ),
  },
  {
    title: 'Generate.',
    text: "One command writes the schema, the section registry and the loader map, and caches what didn't change.",
  },
  {
    title: 'Open it in Studio.',
    text: (
      <>
        Studio reads your schema from <code>/live/_meta</code> and your content from <code>/.decofile</code>, then previews each change on
        your own code.
      </>
    ),
  },
]

const FILE_TABS = [
  { icon: 'file' as const, label: 'Hero.tsx' },
  { icon: 'terminal' as const, label: 'Terminal' },
  { icon: 'eye' as const, label: 'Studio' },
]

/* The generate log, in the real format ("[generate] <generator> <time> (fresh|cached)"); the
   timings are left out on purpose so the mock implies no numbers. */
const LOG: [string, string][] = [
  ['blocks', 'fresh'],
  ['sections', 'fresh'],
  ['loaders', 'cached'],
  ['schema', 'fresh'],
]

const FORM: [string, string][] = [
  ['Headline', 'Summer sale'],
  ['Background image', 'summer.jpg'],
  ['CTA', 'Shop now → /summer'],
]

export function V7Stepper() {
  return (
    <StepperShell
      kicker="From zero to an editable page"
      title={
        <>
          Three steps. <Dim>Then hand it to your editors.</Dim>
        </>
      }
      titleClassName="max-w-[16ch] max-lg:max-w-none"
      lede="The quickstart builds a TanStack Start site on Cloudflare Workers with one section, one page and the endpoints Studio reads."
      steps={STEPS}
      fileTabs={FILE_TABS}
      windowTitle="Deco Blocks · my-store — setup"
      panes={[
        <>
          <Code html={HERO_TSX_HTML} />
          <Result>
            <span>
              <code>src/sections/Hero.tsx</code> is now a section editors can place.
            </span>
          </Result>
        </>,
        <>
          <div className="flex gap-3 mt-[22px] mx-6 py-[13px] px-[18px] rounded-full bg-term-bg font-mono text-13 leading-5 font-normal text-[#EAF3D6] overflow-x-auto whitespace-nowrap scrollbar-none max-sm:mt-4 max-sm:mx-4 max-sm:text-12 max-sm:rounded-xl">
            <span className="text-brand font-medium" aria-hidden="true">
              $
            </span>
            <span>bun run generate</span>
          </div>
          <pre className="flex-none mt-4 mx-6 mb-[22px] py-4 px-5 border border-code-border rounded-xl bg-code-bg font-mono text-12.5 leading-6 text-code-fg overflow-x-auto max-sm:mt-3 max-sm:mx-4 max-sm:mb-4 max-sm:px-4 max-sm:text-12">
            <code>
              {LOG.map(([gen, state]) => (
                <span className="block" key={gen}>
                  <span className="text-syn-comment">[generate]</span> {gen} <span className={state === 'fresh' ? 'text-syn-string' : 'text-muted-fg'}>({state})</span>
                </span>
              ))}
              <span className="block">
                <span className="text-syn-comment">[generate]</span> total (3 fresh, 1 cached)
              </span>
            </code>
          </pre>
          <Result>
            <span>
              <code>.deco/meta.gen.json</code> describes every section for Studio.
            </span>
          </Result>
        </>,
        <>
          <div
            className="flex-none mt-[22px] mx-6 mb-[22px] border border-st-border rounded-xl bg-st-bg text-st-fg overflow-hidden max-sm:mt-4 max-sm:mx-4 max-sm:mb-4"
            role="group"
            aria-label="The form Studio builds from the section's Props"
          >
            <div className={`flex items-center gap-2 h-10 px-3.5 border-b border-st-border bg-bg-subtle text-13 font-medium ${symbol}`}>
              <BrandSymbol />
              <span>Home page · Hero</span>
              <span className="ml-auto px-2 py-0.5 border border-st-border rounded-full bg-st-bg font-mono text-11 leading-4 font-normal text-st-muted">
                sections/Hero.tsx
              </span>
            </div>
            {FORM.map(([label, value], i) => (
              <div
                className={`grid grid-cols-[minmax(0,.8fr)_minmax(0,1.2fr)] items-center gap-3 h-[46px] px-3.5 text-13 ${i ? 'border-t border-st-border' : ''}`}
                key={label}
              >
                <span>{label}</span>
                <span className="h-7 flex items-center px-3 border border-st-border rounded-full bg-st-field text-12.5 leading-4 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
                  {value}
                </span>
              </div>
            ))}
          </div>
          <Result>
            <span>Edits preview live. Publishing updates your site.</span>
          </Result>
        </>,
      ]}
    />
  )
}
