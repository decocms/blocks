import type { ComponentProps } from 'react'
import { Link } from '@tanstack/react-router'
import { roadmapTarget, ROADMAP_ROOT } from '~/components/roadmap/sections'

/**
 * Links in content. Write site links as root-relative paths without the base path:
 *   [Quickstart](/next/quickstart)   [Publishing](/next/releases#publishing)   [Roadmap](/roadmap#roadmap-api)
 * They become router links (client-side navigation, base path added). `#id` stays an in-page link;
 * anything else (https://…) is a plain external link.
 *
 * Roadmap links may name just the old id: `/roadmap#roadmap-api--x` goes to the Roadmap page that
 * holds it (/roadmap/api#roadmap-api--x; see components/roadmap/sections.ts), `/roadmap` to /roadmap/.
 */
export function MdxLink({ href = '', children, ...rest }: ComponentProps<'a'>) {
  if (href.startsWith('/') && !href.startsWith('//')) {
    let [path, hash] = href.split('#') as [string, string | undefined]
    if (path === '/roadmap' || path === ROADMAP_ROOT) {
      const t = hash ? roadmapTarget(hash) : undefined
      path = t?.to ?? ROADMAP_ROOT
      // An id that isn't a Roadmap id keeps its fragment, so the post-build link check reports it.
      hash = t ? t.hash : hash
    }
    return (
      <Link to={path || '/'} hash={hash} activeOptions={{ exact: true, includeHash: true }} activeProps={{}} {...rest}>
        {children}
      </Link>
    )
  }
  const external = /^[a-z][a-z0-9+.-]*:/i.test(href)
  return (
    <a href={href} rel={external ? 'noopener' : undefined} {...rest}>
      {children}
    </a>
  )
}
