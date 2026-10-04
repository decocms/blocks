import { useRef } from 'react'
import { Icon } from '~/components/ui/Icon'
import { onRailClick, useRailItems } from '~/src/layout/Rail'
import type { RailItem } from '~/src/lib/nav'
import { cx } from '~/src/lib/ui'

/**
 * The collapsible "On this page" outline shown below 1200px. Inserted automatically after each
 * page's h1 and lede by build/rehype-docs.ts; you never write it yourself.
 */
export function TocInline() {
  return <TocInlineView items={useRailItems()} />
}

const hrefOf = (item: RailItem) => (item.id ? `#${item.id}` : '#main')

/**
 * The outline itself: the rail's items in a <details>. `toc-inline` stays as a hook (the search
 * index skips it); `not-prose` keeps the article's list and link styles out.
 */
export function TocInlineView({ items }: { items: RailItem[] }) {
  const ref = useRef<HTMLDetailsElement>(null)
  if (items.length < 2) return null
  return (
    <details className="toc-inline not-prose group mt-7 mb-2 hidden rounded-2xl border border-border bg-bg-subtle max-rail:block print:hidden" id="toc-inline" ref={ref}>
      <summary className="flex h-[46px] cursor-pointer list-none items-center gap-2.5 rounded-2xl px-4 eyebrow-label [&::-webkit-details-marker]:hidden">
        <Icon name="list" className="text-eyebrow" />
        <span className="flex-1">On this page</span>
        <Icon name="chevron-down" className="text-muted-fg transition-transform duration-300 ease-out-quart group-open:rotate-180" />
      </summary>
      <ul className="m-0 list-none border-t border-hairline pt-1 pr-4 pb-3 pl-[22px]" id="toc-inline-list">
        {items.map((item) => (
          <li key={item.id ?? '_top'}>
            <a
              href={hrefOf(item)}
              className={cx(
                // toc-link (src/styles/components/docs.css): the look shared with the rail.
                'toc-link rounded-[2px] py-[7px] text-14 leading-5 font-normal hover:text-fg',
                item.depth === 1 ? 'text-fg' : 'text-muted-fg',
                item.depth === 3 && 'pl-4',
                'has-[>.gx-n]:pl-[22px]',
              )}
              onClick={(e) => {
                if (ref.current) ref.current.open = false
                onRailClick(item, e)
              }}
              dangerouslySetInnerHTML={{ __html: item.html }}
            />
          </li>
        ))}
      </ul>
    </details>
  )
}
