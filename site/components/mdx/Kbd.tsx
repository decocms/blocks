import type { ReactNode } from 'react'

/** A key or shortcut: <Kbd>⌘K</Kbd>. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>
}
