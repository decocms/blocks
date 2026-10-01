/**
 * Light/dark theme. No attribute = follow the OS (prefers-color-scheme); data-theme="light|dark"
 * on <html> = the reader's choice, remembered in localStorage. `?theme=dark|light` in the URL
 * overrides both (handy for screenshots), without being saved.
 */
export const THEME_KEY = 'deco-blocks-docs-theme'

/** Runs in <head> before first paint (inlined by __root.tsx), so there's no flash of the wrong theme. */
export const THEME_INIT_SCRIPT = `(function(){var d=document.documentElement,t=null;d.classList.add('js');try{var q=new URLSearchParams(location.search).get('theme');t=(q==='dark'||q==='light')?q:localStorage.getItem('${THEME_KEY}');}catch(e){}if(t==='dark'||t==='light')d.setAttribute('data-theme',t);})();`

export type Theme = 'light' | 'dark'

export function effectiveTheme(): Theme {
  const t = document.documentElement.dataset.theme
  if (t === 'dark' || t === 'light') return t
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export const THEME_CHANGE_EVENT = 'docs:theme-change'

export function setTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    /* private mode */
  }
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: theme }))
}
