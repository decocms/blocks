/**
 * The v7 stepper's code pane (src/sections/Hero.tsx), hand-tokenised as an HTML string coloured with
 * the syntax tokens, like ../tokens.tsx does for the next major's panes.
 */
const TOKEN = {
  keyword: 'text-syn-keyword',
  punctuation: 'text-syn-punctuation',
  operator: 'text-syn-operator',
  string: 'text-syn-string',
  comment: 'text-syn-comment italic',
  function: 'text-syn-function',
  type: 'text-syn-type',
  property: 'text-syn-property',
}
const tok = (kind: keyof typeof TOKEN, text: string) => `<span class="${TOKEN[kind]}">${text}</span>`
const kw = (t: string) => tok('keyword', t)
const pu = (t: string) => tok('punctuation', t)
const ty = (t: string) => tok('type', t)
const str = (t: string) => tok('string', t)
const cm = (t: string) => tok('comment', t)
const fn = (t: string) => tok('function', t)
const pr = (t: string) => tok('property', t)

export const HERO_TSX_HTML = [
  `${kw('import')} ${kw('type')} ${pu('{')} ImageWidget ${pu('}')} ${kw('from')} ${str('"@decocms/blocks/types/widgets"')}${pu(';')}`,
  '',
  `${kw('export')} ${kw('interface')} ${ty('Props')} ${pu('{')}`,
  `  ${cm('/** @title Headline */')}`,
  `  ${pr('title')}${pu(':')} ${ty('string')}${pu(';')}`,
  `  ${cm('/** @title Background image */')}`,
  `  ${pr('image')}${pu(':')} ${ty('ImageWidget')}${pu(';')}`,
  `  ${pr('cta')}${pu('?:')} ${pu('{')} ${pr('label')}${pu(':')} ${ty('string')}${pu(';')} ${pr('href')}${pu(':')} ${ty('string')} ${pu('};')}`,
  pu('}'),
  '',
  `${kw('export')} ${kw('default')} ${kw('function')} ${fn('Hero')}${pu('({')} title${pu(',')} image${pu(',')} cta ${pu('}:')} ${ty('Props')}${pu(')')} ${pu('{')}`,
  `  ${kw('return')} ${pu('(')}`,
  `    ${pu('&lt;')}section${pu('&gt;')} ${cm('{/* your markup */}')} ${pu('&lt;/')}section${pu('&gt;')}`,
  `  ${pu(')')}${pu(';')}`,
  pu('}'),
].join('\n')
