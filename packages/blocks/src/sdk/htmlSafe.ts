/**
 * Context-aware escaping for values interpolated into inline `<script>` /
 * `<style>` bodies via `dangerouslySetInnerHTML`.
 *
 * Why this exists: inside a `<script>`/`<style>` element the HTML parser — not
 * the JS/JSON/CSS grammar — decides where the element ends. It closes at the
 * first literal `</script>` / `</style>` regardless of quoting or JSON context.
 * `JSON.stringify` escapes JSON metacharacters but NOT `<`, so a string value
 * containing `</script>` breaks out of the tag and injects markup. React does
 * not escape inside `dangerouslySetInnerHTML`. These helpers close that class:
 * always run untrusted (or possibly-untrusted) values through the matching
 * helper for the surrounding context, never bare `JSON.stringify`/interpolation.
 */

// Built via RegExp() so the source file never contains a raw U+2028/U+2029
// byte — those are JS line terminators and would break the parser here.
const LINE_SEP = new RegExp("\\u2028", "g");
const PARA_SEP = new RegExp("\\u2029", "g");

/**
 * Serialize a value to JSON that is safe to embed directly in a `<script>`
 * body. `<`, `>`, `&` and the JS line terminators U+2028/U+2029 are emitted as
 * their `\uXXXX` JSON escapes — still valid JSON that parses back to the same
 * value, but with no raw `</script>` (or `<!--`) able to reach the HTML stream.
 */
export function htmlSafeJson(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(LINE_SEP, "\\u2028")
    .replace(PARA_SEP, "\\u2029");
}

/**
 * Escape a value for interpolation into a `<style>` body. Neutralizes a
 * `</style>` tag breakout by CSS-escaping `<`/`>` (`\3c `/`\3e `) — both are
 * invalid in a real CSS value/selector, so escaping never changes legit output.
 */
export function cssSafe(css: string): string {
  return css.replace(/</g, "\\3c ").replace(/>/g, "\\3e ");
}

/**
 * Escape a value for interpolation inside a single- or double-quoted JS string
 * literal in an inline `<script>` (e.g. `foo('${jsString(x)}')`). Neutralizes
 * both string-literal breakout (quotes/backslash/newlines) and tag breakout
 * (`<` -> `<`, so `</script>` can never appear).
 */
export function jsString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/`/g, "\\`")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(LINE_SEP, "\\u2028")
    .replace(PARA_SEP, "\\u2029");
}
