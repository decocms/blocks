/**
 * v7's `clx` (`@decocms/blocks/sdk/clx` on 7.x): drops falsy class names,
 * joins the rest with a space and collapses runs of whitespace. Byte-for-byte
 * v7's output; `clx.test.ts` pins it against v7's own code.
 */

/** Filter out nullable values, join and minify class names */
export const clx = (...args: (string | null | undefined | false)[]) =>
  args.filter(Boolean).join(" ").replace(/\s\s+/g, " ");

export default clx;
