/**
 * Small browser-side helpers shared by the shell and by components in other folders.
 *
 *   toast('Link copied')        the bottom toast (also announced to screen readers)
 *   announce('Copied')          screen-reader-only announcement (the #live region)
 *   copyText(text)              clipboard with a textarea fallback; resolves to success
 *   openSearch()                asks the search dialog to open (dispatches SEARCH_OPEN_EVENT)
 *   closeMenu()                 closes the mobile drawer if open
 *   cx(a, cond && b)            joins utility class names, skipping falsy ones
 *
 * They're DOM events, so the shell (src/layout/*) and feature folders (components/search, …)
 * don't import each other.
 */
export const TOAST_EVENT = 'docs:toast'
export const ANNOUNCE_EVENT = 'docs:announce'
/** Fired by the ⌘K button, the drawer's search button, and the keyboard shortcuts (⌘K, Ctrl+K, /). */
export const SEARCH_OPEN_EVENT = 'docs:search-open'
export const MENU_CLOSE_EVENT = 'docs:menu-close'

const fire = (name: string, detail?: unknown) => {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(name, { detail }))
}

export const toast = (message: string) => fire(TOAST_EVENT, message)
export const announce = (message: string) => fire(ANNOUNCE_EVENT, message)
export const openSearch = () => fire(SEARCH_OPEN_EVENT)
export const closeMenu = () => fire(MENU_CLOSE_EVENT)

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const field = document.createElement('textarea')
    field.value = text
    field.setAttribute('readonly', '')
    field.style.position = 'fixed'
    field.style.opacity = '0'
    document.body.append(field)
    field.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    field.remove()
    return ok
  }
}

export const prefersReducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches

/** Joins class names, skipping falsy entries: cx('a', on && 'b', undefined). */
export const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(' ')
