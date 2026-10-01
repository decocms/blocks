/**
 * deco's brand marks (the same files as in the public decocms/studio repository), inlined as SVG
 * so CSS can pick the variant that matches the theme.
 *
 *   <Wordmark />      both variants: .wm.wm-light and .wm.wm-dark (CSS shows one per theme)
 *   <WordmarkLime />  the on-dark (lime) variant alone, class "wm wm-lime" (footer, hero)
 *   <BrandSymbol />   the "d" symbol, both variants: .sym.sym-light / .sym.sym-dark
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

const html = {
  wordmark: brandSvg(wordmarkLight, 'wm wm-light') + brandSvg(wordmarkDark, 'wm wm-dark'),
  wordmarkLime: brandSvg(wordmarkDark, 'wm wm-lime'),
  symbol: brandSvg(symbolLight, 'sym sym-light') + brandSvg(symbolDark, 'sym sym-dark'),
}

// `display: contents` keeps the wrapper out of layout, so the SVGs behave as direct children.
export const Wordmark = () => <span style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: html.wordmark }} />
export const WordmarkLime = () => <span style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: html.wordmarkLime }} />
export const BrandSymbol = () => <span style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: html.symbol }} />

/** The raw strings, for code that needs markup rather than elements. */
export const brandHtml = html
