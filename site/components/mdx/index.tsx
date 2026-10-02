/**
 * The components MDX pages can use, and the HTML element overrides. See README.md for the API.
 *
 * Widgets (interactive pieces like the walkthrough) live in components/widgets/; anything that
 * folder's index.tsx exports by name is available to MDX too, e.g. `<Walkthrough />`.
 */
import type { ComponentType } from 'react'
import type { MDXComponents } from 'mdx/types'
import { Callout } from './Callout'
import { Hosted } from './Hosted'
import { CodeBlock } from './CodeBlock'
import { Table } from './Table'
import { H1, H2, H3 } from './Heading'
import { MdxLink } from './MdxLink'
import { Flow, FlowNode } from './Flow'
import { Terms, Term } from './Terms'
import { Steps, Step } from './Steps'
import { Kbd } from './Kbd'
import { Small, Eyebrow } from './Small'
import { TocInline } from './TocInline'

export { Callout, Hosted, CodeBlock, Table, H1, H2, H3, MdxLink, Flow, FlowNode, Terms, Term, Steps, Step, Kbd, Small, Eyebrow, TocInline }

const widgetModules = import.meta.glob<Record<string, unknown>>('/components/widgets/index.tsx', { eager: true })
const widgets: Record<string, ComponentType<never>> = {}
for (const mod of Object.values(widgetModules))
  for (const [name, value] of Object.entries(mod)) if (/^[A-Z]/.test(name) && typeof value === 'function') widgets[name] = value as ComponentType<never>

export const mdxComponents: MDXComponents = {
  // element overrides
  a: MdxLink,
  pre: CodeBlock,
  table: Table,
  h1: H1,
  h2: H2,
  h3: H3,
  // components
  Callout,
  Hosted,
  Flow,
  FlowNode,
  Terms,
  Term,
  Steps,
  Step,
  Kbd,
  Small,
  Eyebrow,
  TocInline,
  ...(widgets as MDXComponents),
}
