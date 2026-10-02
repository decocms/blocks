import type { ReactNode } from 'react'

/**
 * A glossary: bold terms with their definitions (a <dl>).
 *
 *   <Terms>
 *     <Term name="Block function">One of your functions with a typed first parameter… See [Quickstart](/next/quickstart).</Term>
 *     <Term name="Block map">A plain object of your block functions, such as `{ experiments }`.</Term>
 *   </Terms>
 */
export function Terms({ children }: { children: ReactNode }) {
  return <dl className="my-[18px]">{children}</dl>
}

export function Term({ name, children }: { name: ReactNode; children: ReactNode }) {
  return (
    <>
      <dt className="mt-3.5 text-16 leading-[1.6] font-semibold text-fg first:mt-0">{name}</dt>
      <dd className="mt-0.5 text-16 leading-[1.72] text-fg-body">{children}</dd>
    </>
  )
}
