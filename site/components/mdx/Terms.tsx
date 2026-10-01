import type { ReactNode } from 'react'

/**
 * A glossary: bold terms with their definitions (a <dl class="terms">).
 *
 *   <Terms>
 *     <Term name="Block function">One of your functions with a typed first parameter… See [Quickstart](/next/quickstart).</Term>
 *     <Term name="Block map">A plain object of your block functions, such as `{ experiments }`.</Term>
 *   </Terms>
 */
export function Terms({ children }: { children: ReactNode }) {
  return <dl className="terms">{children}</dl>
}

export function Term({ name, children }: { name: ReactNode; children: ReactNode }) {
  return (
    <>
      <dt>{name}</dt>
      <dd>{children}</dd>
    </>
  )
}
