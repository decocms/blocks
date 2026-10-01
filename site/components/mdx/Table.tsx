import type { ComponentProps } from 'react'

/** Every Markdown/GFM table renders inside a horizontally scrolling, bordered wrapper. */
export function Table(props: ComponentProps<'table'>) {
  return (
    <div className="table-wrap">
      <table {...props} />
    </div>
  )
}
