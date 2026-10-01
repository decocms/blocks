import { TocInlineView, useRailItems } from '~/src/layout/Rail'

/**
 * The collapsible "On this page" outline shown below 1200px. Inserted automatically after each
 * page's h1 and lede by build/rehype-docs.ts; you never write it yourself.
 */
export function TocInline() {
  return <TocInlineView items={useRailItems()} />
}
