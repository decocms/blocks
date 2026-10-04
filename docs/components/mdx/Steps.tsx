import type { ReactNode } from 'react'

/**
 * Numbered rows ("01", "02", … on hairlines). A plain Markdown ordered list (`1. …`) already
 * renders this way inside an article; use <Steps> when a step needs block content that Markdown
 * list syntax makes awkward.
 *
 *   <Steps>
 *     <Step>**Serve from memory.** `load()` returns the newest release…</Step>
 *     <Step>**Ask for the hash.** …</Step>
 *   </Steps>
 */
export function Steps({ children }: { children: ReactNode }) {
  return <ol>{children}</ol>
}

export function Step({ children }: { children: ReactNode }) {
  return <li>{children}</li>
}
