import { useEffect, useRef } from 'react'
import { prefersReducedMotion } from '~/src/lib/ui'

/**
 * The site's deco-reveal: every `.reveal` inside the returned ref fades up once (adds `.in`) when
 * it first enters the viewport. A scroll check backs up the observer (anything scrolled into or
 * past view is shown); reduced motion, no IntersectionObserver, and printing show everything.
 * `.reveal` is only hidden under `html.js` (set before paint), so the prerendered page reads fine
 * without JS.
 */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  useEffect(() => {
    const root = ref.current
    if (!root) return
    let pending = Array.from(root.querySelectorAll<HTMLElement>('.reveal:not(.in)'))
    const show = (el: HTMLElement) => el.classList.add('in')
    const revealAll = () => {
      pending.forEach(show)
      pending = []
    }
    if (prefersReducedMotion() || !('IntersectionObserver' in window)) {
      revealAll()
      return
    }
    const check = () => {
      if (!pending.length) return
      const limit = innerHeight * 0.95
      pending = pending.filter((el) => {
        const r = el.getBoundingClientRect()
        if (r.width && r.top < limit) {
          show(el)
          return false
        }
        return true
      })
    }
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return
          const el = entry.target as HTMLElement
          show(el)
          io.unobserve(el)
          pending = pending.filter((p) => p !== el)
        }),
      { rootMargin: '0px 0px -6% 0px', threshold: 0.05 },
    )
    pending.forEach((el) => io.observe(el))
    let scheduled = false
    const onScroll = () => {
      if (scheduled) return
      scheduled = true
      requestAnimationFrame(() => {
        scheduled = false
        check()
      })
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    window.addEventListener('beforeprint', revealAll)
    requestAnimationFrame(check)
    return () => {
      io.disconnect()
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      window.removeEventListener('beforeprint', revealAll)
    }
  }, [])
  return ref
}
