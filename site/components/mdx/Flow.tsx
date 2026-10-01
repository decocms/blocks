import { Children, Fragment, isValidElement, type ReactNode } from 'react'

/**
 * A left-to-right diagram of numbered steps (stacks vertically on phones). Arrows are drawn
 * between nodes automatically.
 *
 *   <Flow label="Authoring flow">
 *     <FlowNode title="Your TypeScript">Functions with typed inputs: UI and data fetchers alike</FlowNode>
 *     <FlowNode title="CLI → JSON Schema">`deco schema` writes `.deco/schema.json`</FlowNode>
 *     <FlowNode title="Studio">Forms and previews for editors, built from the schema</FlowNode>
 *   </Flow>
 *
 * `title` may be JSX (`title={<code>load()</code>}`). Keep a node's text on the same line as its
 * tags so MDX doesn't wrap it in a paragraph.
 */
export function Flow({ label, children }: { label?: string; children: ReactNode }) {
  const nodes = Children.toArray(children).filter(isValidElement)
  const cols = nodes.flatMap((_, i) => (i ? ['1px', 'minmax(0, 1fr)'] : ['minmax(0, 1fr)'])).join(' ')
  return (
    <div className="flow" aria-label={label} style={nodes.length === 3 ? undefined : { gridTemplateColumns: cols }}>
      {nodes.map((node, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <div className="flow-arrow" aria-hidden="true">
              →
            </div>
          )}
          {node}
        </Fragment>
      ))}
    </div>
  )
}

export function FlowNode({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flow-node">
      <strong>{title}</strong>
      {children != null && <small>{children}</small>}
    </div>
  )
}
