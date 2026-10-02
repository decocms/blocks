/**
 * The landing's shared pieces: motion, the 1200px container, section headings, buttons, text
 * links, and the browser-window mock. Everything is Tailwind utilities; a class string kept in a
 * constant here is still a literal, so Tailwind's scanner sees it.
 */
import type { CSSProperties, ReactNode } from 'react'

/** `style={d('120ms')}`: the entrance/reveal delay (`--d`) the old markup set inline. */
export const d = (ms: string) => ({ '--d': ms }) as CSSProperties

/** Entrance on load (the hero). */
export const enter = 'animate-enter [animation-delay:var(--d,0ms)]'

/**
 * Fades up once on first scroll-in. `reveal` stays the hook useReveal queries (it adds `.in`); the
 * element is only hidden with JS on, motion allowed and not printing, until it has `.in`.
 */
export const reveal =
  'reveal transition-[opacity,translate] duration-1000 ease-out-expo delay-(--d) js:motion-safe:not-print:not-[.in]:opacity-0 js:motion-safe:not-print:not-[.in]:translate-y-6'

/** The 1200px landing column with its 40px (16px on phones) gutters. */
export const container = 'mx-auto w-full max-w-landing px-10 max-sm:px-4'

/** Sections' vertical rhythm (112px; 80px on phones). */
export const section = 'py-28 max-sm:py-20'
/** Every landing band after the stack strip starts with a hairline. */
export const lsec = 'border-t border-hairline'
export const sectionHead = 'max-w-[720px] mb-14 max-sm:mb-9'

const ON_BAND = { kicker: 'text-lime', h2: 'text-white', dim: 'text-[rgba(255,255,255,.5)]', lede: 'text-band-muted' }
const ON_PAPER = { kicker: 'text-eyebrow', h2: 'text-fg', dim: 'text-muted-fg', lede: 'text-muted-fg' }
type Tone = { band?: boolean }

export function Kicker({ band, className = '', children, ...rest }: Tone & { className?: string; children: ReactNode; style?: CSSProperties; id?: string }) {
  return (
    <p className={`block mb-5 text-13 leading-4.5 font-normal tracking-ui uppercase ${band ? ON_BAND.kicker : ON_PAPER.kicker} ${className}`} {...rest}>
      {children}
    </p>
  )
}

/** The section h2 (fluid 30–48px). */
export const h2 = 'm-0 text-section leading-[1.17] font-normal tracking-heading text-balance'
export const H2 = ({ band, className = '', children, ...rest }: Tone & { className?: string; children: ReactNode; style?: CSSProperties; id?: string }) => (
  <h2 className={`${h2} ${band ? ON_BAND.h2 : ON_PAPER.h2} ${className}`} {...rest}>
    {children}
  </h2>
)
export const Dim = ({ band, className = '', children }: Tone & { className?: string; children: ReactNode }) => (
  <span className={`${band ? ON_BAND.dim : ON_PAPER.dim} ${className}`}>{children}</span>
)

export const Lede = ({ band, className = '', children, ...rest }: Tone & { className?: string; children: ReactNode; style?: CSSProperties }) => (
  <p className={`mt-3 max-w-[620px] text-17 leading-normal max-sm:text-16 [&_code]:text-[.82em] ${band ? ON_BAND.lede : ON_PAPER.lede} ${className}`} {...rest}>
    {children}
  </p>
)

/** The hero/final CTA row and its pill buttons. */
export const cta = 'flex flex-wrap items-center gap-3 mt-9 max-sm:mt-[30px] max-sm:gap-2.5'
const btn =
  'h-12 px-6 py-3 inline-flex items-center justify-center gap-2 border-0 rounded-full text-16 leading-6 font-medium tracking-ui no-underline whitespace-nowrap transition-[scale,background-color,color,box-shadow,opacity] ease-out-quart active:scale-[.97] max-sm:flex-auto'
export const btnPrimary = `${btn} bg-brand text-brand-ink hover:bg-brand-hover`
export const btnWhite = `${btn} bg-white text-[#282524] hover:bg-[#EEF1F2]`
/** The secondary button on paper (the final CTA). */
export const btnOutline = `${btn} bg-surface text-fg shadow-[inset_0_0_0_1px_var(--border-strong)] hover:bg-bg-subtle`

/** "Follow the quickstart →": an arrow link; the arrow nudges right on hover. */
export const textLink = 'group inline-flex items-center gap-1.5 flex-none text-15 leading-5.5 font-medium no-underline rounded-sm'
export const textLinkIcon = 'size-[15px] transition-transform duration-350 ease-out-quart group-hover:translate-x-[3px]'
/** "For developers: … →": the same link as a block that wraps, the arrow kept with the last word. */
export const devLink = 'group block w-fit max-w-full mt-9 gap-1.5 text-15 leading-5.5 font-medium no-underline rounded-sm'
export const devLinkIcon = `${textLinkIcon} inline-block ml-1.5 align-[-2px]`

/**
 * The browser-window mock: a frame (`win` plus its own background, border colour and shadow, which
 * differ per window), a title bar and a centred title, in two sizes (the contract cards' are small).
 */
export const win = 'border overflow-hidden'
/** The usual frame: surface, hairline border, the deep window shadow. */
export const winPaper = `${win} bg-surface border-hairline shadow-win`
const bar = 'relative flex items-center gap-2 border-b border-hairline flex-none'
export const winBar = `${bar} h-[38px] px-4 bg-win-bar`
export const winBarSmall = `${bar} h-8 px-3 bg-win-bar`
/** The hero window's bar, the same colour as its frame. */
export const winBarDark = `${bar} h-[38px] px-4 bg-win-bg`
const title = 'absolute text-center leading-4 text-muted-fg whitespace-nowrap overflow-hidden text-ellipsis'
export const winTitle = `${title} left-22 right-22 text-11.5`
export const winTitleSmall = `${title} left-16 right-16 text-11`

export function Dots({ hidden = false, small }: { hidden?: boolean; small?: boolean }) {
  const dot = small ? 'size-2 rounded-full bg-win-dot' : 'size-2.5 rounded-full bg-win-dot'
  return (
    <span className={`inline-flex flex-none ${small ? 'gap-[5px]' : 'gap-1.5'}`} aria-hidden={hidden ? 'true' : undefined}>
      <i className={dot} />
      <i className={dot} />
      <i className={dot} />
    </span>
  )
}

/** Deco's "d" symbol (<BrandSymbol/>) at 15px, the variant matching the theme (light in print). */
export const symbol =
  '[&_.sym]:size-[15px] [&_.sym]:flex-none [&_.sym-light]:inline-block [&_.sym-dark]:hidden dark:not-print:[&_.sym-light]:hidden dark:not-print:[&_.sym-dark]:inline-block'

/** Mono text without ligatures (the old `.mono`). */
export const mono = 'font-mono [font-variant-ligatures:none] [font-feature-settings:"liga"_0,"calt"_0]'
