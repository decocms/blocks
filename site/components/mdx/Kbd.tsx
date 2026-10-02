import type { ReactNode } from 'react'

/** A key or shortcut: <Kbd>⌘K</Kbd>. (The mono font and 11px size are kbd's base style.) */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>
}
