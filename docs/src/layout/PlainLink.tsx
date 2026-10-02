import type { AnchorHTMLAttributes, MouseEvent } from 'react'
import { useRouter } from '@tanstack/react-router'

/**
 * A router link that leaves `aria-current` to the caller. TanStack's <Link> sets
 * aria-current="page" whenever its target is the current URL, which is wrong for the header tabs
 * (two tabs can point at the same page while a version is incomplete; the tab comes from the
 * route's chrome instead).
 */
export function PlainLink({ to, hash, onClick, ...rest }: { to: string; hash?: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const router = useRouter()
  const href = router.buildLocation({ to, hash } as never).href
  const go = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    router.navigate({ to, hash } as never)
  }
  return <a href={href} onClick={go} {...rest} />
}
