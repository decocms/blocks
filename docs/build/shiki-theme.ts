/**
 * One Shiki theme whose colors are CSS variables (`--syn-*`, defined in src/styles/tokens.css for
 * light, dark and print). Highlighting happens once, at build time, and the page switches palettes
 * with the theme toggle like everything else. The categories mirror the old Prism setup:
 * comment, keyword, string, type, function, number, property, punctuation, operator, tag.
 */
import type { ThemeRegistrationRaw } from 'shiki'

const v = (name: string) => `var(--syn-${name})`

export const decoTheme: ThemeRegistrationRaw = {
  name: 'deco-css-vars',
  type: 'light',
  colors: {
    'editor.foreground': 'var(--code-fg)',
    'editor.background': 'transparent',
  },
  settings: [
    { settings: { foreground: 'var(--code-fg)', background: 'transparent' } },
    { scope: ['comment', 'punctuation.definition.comment', 'string.quoted.docstring'], settings: { foreground: v('comment'), fontStyle: 'italic' } },
    // JSDoc tags inside comments (`@title`) stay plain comment text, as with Prism.
    { scope: ['comment.block.documentation storage.type.class', 'comment storage.type', 'comment.block.documentation entity.name.type', 'comment.block.documentation variable'], settings: { foreground: v('comment'), fontStyle: 'italic' } },
    {
      scope: [
        'keyword',
        'storage.type',
        'storage.modifier',
        'keyword.control',
        'keyword.operator.new',
        'keyword.operator.expression',
        'keyword.operator.typeof',
        'keyword.operator.satisfies',
        'keyword.operator.as',
        'variable.language.this',
        'constant.language.null',
        'constant.language.undefined',
      ],
      settings: { foreground: v('keyword') },
    },
    { scope: ['keyword.operator', 'storage.type.function.arrow', 'keyword.operator.type.annotation'], settings: { foreground: v('operator') } },
    { scope: ['keyword.operator.expression', 'keyword.operator.new', 'keyword.operator.ternary.ts'], settings: { foreground: v('keyword') } },
    { scope: ['string', 'string.quoted', 'string.template', 'punctuation.definition.string', 'string.unquoted.plain.out.yaml'], settings: { foreground: v('string') } },
    { scope: ['constant.numeric', 'constant.language.boolean', 'constant.language.json', 'constant.language'], settings: { foreground: v('number') } },
    { scope: ['string.regexp', 'constant.other.symbol'], settings: { foreground: v('number') } },
    {
      scope: [
        'entity.name.type',
        'entity.name.class',
        'support.type.primitive',
        'support.type.builtin',
        'support.class',
        'entity.other.inherited-class',
        'entity.name.namespace',
        'support.class.component',
        'variable.other.constant.object',
      ],
      settings: { foreground: v('type') },
    },
    { scope: ['entity.name.function', 'support.function', 'meta.function-call entity.name.function', 'entity.name.command', 'support.function.builtin.shell'], settings: { foreground: v('function') } },
    {
      scope: [
        'support.type.property-name',
        'support.type.property-name.json',
        'meta.object-literal.key',
        'variable.other.property',
        'variable.other.object.property',
        'entity.other.attribute-name',
        'entity.name.tag.yaml',
      ],
      settings: { foreground: v('property') },
    },
    { scope: ['punctuation', 'meta.brace', 'punctuation.separator', 'punctuation.terminator', 'punctuation.accessor', 'meta.delimiter'], settings: { foreground: v('punctuation') } },
    { scope: ['entity.name.tag', 'punctuation.definition.tag'], settings: { foreground: v('tag') } },
    { scope: ['punctuation.definition.tag'], settings: { foreground: v('punctuation') } },
    { scope: ['support.class.component.tsx', 'entity.name.tag.tsx support.class.component'], settings: { foreground: v('type') } },
    // Shell arguments (`install`, `@decocms/blocks`, `-D`) are plain text, as with Prism.
    { scope: ['variable.parameter.shell', 'constant.other.option', 'string.unquoted.argument.shell', 'string.unquoted.argument'], settings: { foreground: 'var(--code-fg)' } },
    { scope: ['punctuation.definition.template-expression', 'punctuation.section.embedded'], settings: { foreground: v('keyword') } },
  ],
}
