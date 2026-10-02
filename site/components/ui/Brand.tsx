/**
 * deco's brand marks (the same files as in the public decocms/studio repository), inlined as SVG
 * so CSS can pick the variant that matches the theme.
 *
 *   <Wordmark />      both variants: .wm.wm-light and .wm.wm-dark
 *   <WordmarkLime />  the on-dark (lime) variant alone, class "wm wm-lime" (footer, hero)
 *   <BrandSymbol />   the "d" symbol, both variants: .sym.sym-light / .sym.sym-dark
 *
 * No stylesheet picks the variant: the caller does, with utilities (see BrandProps), e.g.
 * light="dark:hidden" dark="hidden dark:block". The wm-… and sym-… classes are only names to target.
 */
import wordmarkLight from '~/assets/brand/wordmark-on-light.svg?raw'
import wordmarkDark from '~/assets/brand/wordmark-on-dark.svg?raw'
import symbolLight from '~/assets/brand/symbol-on-light.svg?raw'
import symbolDark from '~/assets/brand/symbol-on-dark.svg?raw'

/** Same normalisation as the former Python build (removed): one line, the root <svg> rewritten with a class. */
function brandSvg(raw: string, cls: string): string {
  let s = raw.replace(/\s+/g, ' ').trim().replace(/> </g, '><')
  s = s.replace(
    /<svg[^>]*?viewBox="([^"]+)"[^>]*>/,
    (_m, vb: string) => `<svg class="${cls}" viewBox="${vb}" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">`,
  )
  return s.replace(/ \/>/g, '/>')
}

const raw = { wordmarkLight, wordmarkDark, symbolLight, symbolDark }
const cx = (...c: (string | undefined)[]) => c.filter(Boolean).join(' ')

const html = {
  wordmark: brandSvg(wordmarkLight, 'wm wm-light') + brandSvg(wordmarkDark, 'wm wm-dark'),
  wordmarkLime: brandSvg(wordmarkDark, 'wm wm-lime'),
  symbol: brandSvg(symbolLight, 'sym sym-light') + brandSvg(symbolDark, 'sym sym-dark'),
}

/**
 * Optional utilities: `className` goes on every SVG the component renders; `light` / `dark` go on
 * one variant only, e.g. <Wordmark className="h-6 w-auto" light="dark:hidden" dark="hidden dark:block" />.
 */
type BrandProps = { className?: string; light?: string; dark?: string }

// `display: contents` keeps the wrapper out of layout, so the SVGs behave as direct children.
const Inline = ({ markup }: { markup: string }) => <span style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: markup }} />

export const Wordmark = ({ className, light, dark }: BrandProps = {}) =>
  <Inline markup={className || light || dark ? brandSvg(raw.wordmarkLight, cx('wm wm-light', className, light)) + brandSvg(raw.wordmarkDark, cx('wm wm-dark', className, dark)) : html.wordmark} />
export const WordmarkLime = ({ className }: { className?: string } = {}) =>
  <Inline markup={className ? brandSvg(raw.wordmarkDark, cx('wm wm-lime', className)) : html.wordmarkLime} />
export const BrandSymbol = ({ className, light, dark }: BrandProps = {}) =>
  <Inline markup={className || light || dark ? brandSvg(raw.symbolLight, cx('sym sym-light', className, light)) + brandSvg(raw.symbolDark, cx('sym sym-dark', className, dark)) : html.symbol} />

/** The raw strings, for code that needs markup rather than elements. */
export const brandHtml = html
