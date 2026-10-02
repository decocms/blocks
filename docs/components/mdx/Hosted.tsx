import type { ReactNode } from 'react'
import { cx } from '~/src/lib/ui'
import { hasBlock } from './Callout'
import { EYEBROW } from './Small'
import { MdxLink } from './MdxLink'

/**
 * A short notice on a framework page: what the hosted Deco CMS changes here, and a link to the
 * hosted page that explains it.
 *
 *   <Hosted to="/next/hosted-publishing">**Skip the deploy wait.** With the hosted Deco CMS, …</Hosted>
 *   <Hosted to="/next/hosted#connect-your-site" label="Connect your site">…</Hosted>
 *
 * `to` is a root-relative docs path (an optional #hash), rendered through MdxLink like any content
 * link. Children are one or two sentences; inline content on the tag's line becomes one paragraph.
 */
export function Hosted({ to, label = 'How the hosted Deco CMS does it', children }: { to: string; label?: string; children: ReactNode }) {
  return (
    <aside aria-label={`Hosted Deco CMS: ${label}`} className={HOSTED}>
      {/* The aside's label already names it (and its link) for screen readers; this is its visible twin. */}
      <div aria-hidden="true" className={cx(EYEBROW, 'mb-2! flex items-center gap-2')}>
        <span className="size-2 shrink-0 rounded-full bg-preview-dot shadow-[0_0_0_3px_var(--preview-dot-ring)]" />
        Hosted Deco CMS
      </div>
      {hasBlock(children) ? children : <p>{children}</p>}
      <p className="mt-2.5!">
        <MdxLink href={to} className="font-medium">
          {label}
          <span aria-hidden="true"> →</span>
        </MdxLink>
      </p>
    </aside>
  )
}

/** The notice's classes: a lime-tinted box with a forest (lime in dark mode) left rule. */
const HOSTED = cx(
  'my-7 rounded-box border border-preview-border border-l-4 border-l-preview-dot bg-preview-bg py-4 pr-5.5 pl-5 max-sm:py-3.5 max-sm:pr-4 max-sm:pl-4',
  // the prose layer styles strong, code and the link; paragraphs are 15px with no gap, like <Callout>
  '[&_p]:m-0 [&_p]:text-15 [&_p]:leading-[25px] [&_p]:text-fg-body',
  'print:break-inside-avoid-page',
)
