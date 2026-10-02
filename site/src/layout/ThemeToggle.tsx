import { useEffect, useState } from 'react'
import { Icon } from '~/components/ui/Icon'
import { cx } from '~/src/lib/ui'
import { effectiveTheme, setTheme, THEME_CHANGE_EVENT, type Theme } from '~/src/lib/theme'

/**
 * The theme toggle. Both icons render and the `dark:` variant shows the right one for the active
 * theme, so the server HTML is correct before hydration. `withLabel` adds the drawer's text;
 * `iconClassName` sizes the icons.
 */
export function ThemeToggle({ className, iconClassName, id, withLabel }: { className: string; iconClassName?: string; id?: string; withLabel?: boolean }) {
  const [next, setNext] = useState<Theme>('dark')
  useEffect(() => {
    const sync = () => setNext(effectiveTheme() === 'dark' ? 'light' : 'dark')
    sync()
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    mq?.addEventListener?.('change', sync)
    window.addEventListener(THEME_CHANGE_EVENT, sync)
    return () => {
      mq?.removeEventListener?.('change', sync)
      window.removeEventListener(THEME_CHANGE_EVENT, sync)
    }
  }, [])
  const label = `Switch to ${next} mode`
  return (
    <button className={className} id={id} type="button" data-theme-toggle aria-label={label} title={label} onClick={() => setTheme(effectiveTheme() === 'dark' ? 'light' : 'dark')}>
      <Icon name="sun" className={cx('hidden dark:block', iconClassName)} />
      <Icon name="moon" className={cx('block dark:hidden', iconClassName)} />
      {withLabel && <span>{next === 'dark' ? 'Dark mode' : 'Light mode'}</span>}
    </button>
  )
}
