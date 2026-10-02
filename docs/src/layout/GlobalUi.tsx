import { useEffect, useRef, useState, type ComponentType } from 'react'
import { useRouter } from '@tanstack/react-router'
import { ANNOUNCE_EVENT, openSearch, TOAST_EVENT } from '~/src/lib/ui'

/**
 * The search dialog is owned by components/search/. It's picked up here if that folder exports a
 * default component from index.tsx; until then the ⌘K button does nothing visible.
 */
const searchModules = import.meta.glob<{ default: ComponentType }>('/components/search/index.tsx', { eager: true })
const SearchDialog = Object.values(searchModules)[0]?.default

/**
 * Toast (its entrance keyframe animates `transform` from translate(-50%, 10px), hence the plain
 * `transform` instead of a translate utility), screen-reader live region, global keyboard shortcuts (⌘K / Ctrl+K / "/"), the search
 * dialog, and route-change focus: after a client-side navigation to another page, focus moves to
 * the new page's h1 (as the old page did when switching sections) and its title is announced, so
 * keyboard and screen-reader users land on the new content instead of the link they left.
 */
export function GlobalUi() {
  const router = useRouter()
  const [message, setMessage] = useState<string | null>(null)
  const [live, setLive] = useState('')
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const liveTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    const announce = (text: string) => {
      // Cleared first and set a beat later, so a repeat of the same message is still read out.
      setLive('')
      clearTimeout(liveTimer.current)
      liveTimer.current = setTimeout(() => setLive(text), 60)
    }
    const onToast = (e: Event) => {
      const text = String((e as CustomEvent).detail ?? '')
      setMessage(text)
      announce(text)
      clearTimeout(toastTimer.current)
      toastTimer.current = setTimeout(() => setMessage(null), 2200)
    }
    const onAnnounce = (e: Event) => announce(String((e as CustomEvent).detail ?? ''))
    const onKey = (event: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement as HTMLElement | null)?.tagName ?? '')
      const dialogOpen = !!document.querySelector('dialog[open]')
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        openSearch()
      } else if (event.key === '/' && !typing && !dialogOpen) {
        event.preventDefault()
        openSearch()
      }
    }
    const offRendered = router.subscribe('onRendered', (event) => {
      // Not on the first load, and not for a #hash change on the same page.
      if (!event.fromLocation || !event.pathChanged) return
      requestAnimationFrame(() => {
        // A link to a heading scrolls there; keep focus off the h1 so nothing scrolls it back.
        if (!event.toLocation.hash) {
          const h1 = document.querySelector<HTMLElement>('#main h1')
          if (h1) {
            if (!h1.hasAttribute('tabindex')) h1.tabIndex = -1
            h1.focus({ preventScroll: true })
          }
        }
        announce(document.title.replace(/ — Deco Blocks$/, ''))
      })
    })
    window.addEventListener(TOAST_EVENT, onToast)
    window.addEventListener(ANNOUNCE_EVENT, onAnnounce)
    document.addEventListener('keydown', onKey)
    // Print: open every <details> while printing, then restore.
    let printed: [HTMLDetailsElement, boolean][] = []
    const before = () => {
      printed = [...document.querySelectorAll('details')].map((d) => [d, d.open])
      printed.forEach(([d]) => (d.open = true))
    }
    const after = () => printed.forEach(([d, open]) => (d.open = open))
    window.addEventListener('beforeprint', before)
    window.addEventListener('afterprint', after)
    return () => {
      offRendered()
      window.removeEventListener(TOAST_EVENT, onToast)
      window.removeEventListener(ANNOUNCE_EVENT, onAnnounce)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('beforeprint', before)
      window.removeEventListener('afterprint', after)
    }
  }, [router])

  return (
    <>
      {SearchDialog && <SearchDialog />}
      <div
        className="fixed bottom-6 left-1/2 z-120 inline-flex h-11 animate-toast-in items-center gap-2 rounded-full bg-forest px-5 text-14 font-medium text-lime shadow-float [transform:translateX(-50%)] print:hidden"
        id="toast"
        aria-hidden="true"
        hidden={!message}
      >
        {message}
      </div>
      <p className="sr-only" id="live" role="status" aria-live="polite">
        {live}
      </p>
    </>
  )
}
