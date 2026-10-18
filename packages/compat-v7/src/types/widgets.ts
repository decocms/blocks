/**
 * v7's widget aliases (`@decocms/blocks/types/widgets` on 7.x). Each is a
 * `string`; the name is what matters: `deco schema` reads the alias as
 * written on a prop and gives the field the site editor's widget
 * (`ImageWidget` an image picker, `RichText` a rich-text editor, `Color` a
 * color picker, …), as v7 did. `Secret` makes the field a secret block, the
 * same as v8's `Secret` from `@decocms/blocks` (v7 made it a password field).
 */
export type ImageWidget = string;
export type HTMLWidget = string;
export type VideoWidget = string;
export type TextWidget = string;
export type RichText = string;
export type Secret = string;
export type Color = string;
export type ButtonWidget = string;
export type TextArea = string;
