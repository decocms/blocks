import type { ComponentProps } from 'react'
import { cx } from '~/src/lib/ui'

/**
 * Every Markdown/GFM table renders inside a horizontally scrolling, bordered wrapper. On phones the
 * table keeps a minimum width (wider with three or more columns) and scrolls. The cells are MDX
 * output, so their look is in the article's prose layer (src/styles/prose.css).
 */
export function Table(props: ComponentProps<'table'>) {
  return (
    <div className="my-7 w-full overflow-x-auto rounded-box border border-border bg-surface [scrollbar-width:thin] max-sm:rounded-xl print:break-inside-avoid-page print:overflow-visible print:shadow-none">
      <table
        {...props}
        className={cx('w-full border-collapse text-14 leading-5.5 max-sm:min-w-[520px] max-sm:text-13.5 max-sm:has-[tr>:nth-child(3)]:min-w-[640px]', props.className)}
      />
    </div>
  )
}
