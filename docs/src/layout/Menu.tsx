import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { MENU_CLOSE_EVENT } from '~/src/lib/ui'

/**
 * The mobile navigation drawer (below 900px the sidebar slides in from the right). While open it is
 * modal: body.nav-open, the sidebar becomes role="dialog", and the header, #main and the site footer are inert.
 */
interface MenuState {
  open: boolean
  openMenu: () => void
  close: (restoreFocus?: boolean) => void
  buttonRef: RefObject<HTMLButtonElement | null>
}

const MenuContext = createContext<MenuState | null>(null)

export function MenuProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const openMenu = useCallback(() => setOpen(true), [])
  const close = useCallback((restoreFocus?: boolean) => {
    setOpen((was) => {
      if (was && restoreFocus) setTimeout(() => buttonRef.current?.focus(), 0)
      return false
    })
  }, [])
  const href = useRouterState({ select: (s) => s.location.href })

  useEffect(() => close(false), [href, close])

  useEffect(() => {
    document.body.classList.toggle('nav-open', open)
    const behind = [document.getElementById('site-header'), document.getElementById('main'), document.querySelector<HTMLElement>('.site-footer')].filter(Boolean) as HTMLElement[]
    behind.forEach((el) => (el.inert = open))
    if (open) {
      const t = setTimeout(() => {
        const first =
          document.querySelector<HTMLElement>('#toc a.active') ??
          document.querySelector<HTMLElement>('.drawer-tabs a') ??
          document.getElementById('menu-close')
        first?.focus({ preventScroll: true })
      }, 50)
      return () => clearTimeout(t)
    }
  }, [open])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true)
    }
    const onResize = () => {
      if (window.innerWidth >= 900) close(false)
    }
    const onClose = () => close(false)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    window.addEventListener(MENU_CLOSE_EVENT, onClose)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
      window.removeEventListener(MENU_CLOSE_EVENT, onClose)
    }
  }, [close])

  const value = useMemo(() => ({ open, openMenu, close, buttonRef }), [open, openMenu, close])
  return <MenuContext.Provider value={value}>{children}</MenuContext.Provider>
}

export function useMenu(): MenuState {
  const ctx = useContext(MenuContext)
  if (!ctx) throw new Error('useMenu outside <MenuProvider>')
  return ctx
}
