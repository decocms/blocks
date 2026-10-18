/**
 * v7's inline-script helpers (`@decocms/blocks/sdk/useScript` on 7.x), with
 * the same output byte for byte (`script.test.ts` pins it against v7's own
 * code). The one change: v7 logged a development warning on each new
 * function, read from `process.env.NODE_ENV`; a package reads no
 * environment, so the warning is gone. The advice stands: prefer
 * {@link inlineScript} with a string, because `fn.toString()` can differ
 * between the server and the client build and break hydration.
 *
 * Not ported: v7's `useSection` / `usePartialSection` stubs (the Fresh HTMX
 * pattern has no v8 equivalent).
 */

// A bounded memo of minified function bodies (the minification is a pure
// function of the source text, so sharing it across requests is safe).
const MAX_CACHE_SIZE = 200;
const minifyCache = new Map<string, string>();

function cacheGet(key: string): string | undefined {
  const value = minifyCache.get(key);
  if (value !== undefined) {
    minifyCache.delete(key);
    minifyCache.set(key, value);
  }
  return value;
}

function cacheSet(key: string, value: string) {
  if (minifyCache.size >= MAX_CACHE_SIZE) {
    const oldest = minifyCache.keys().next().value;
    if (oldest !== undefined) minifyCache.delete(oldest);
  }
  minifyCache.set(key, value);
}

function minifyJs(code: string): string {
  return (
    code
      // Block comments only: stripping line comments or spacing around
      // operators could corrupt string and regex literals.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Serializes a function and its arguments into a self-executing script:
 * `(<minified fn>)(<JSON args>)`.
 *
 * @deprecated `fn.toString()` can differ between the server and the client
 * build, which breaks hydration of `dangerouslySetInnerHTML`. Use
 * {@link inlineScript} with a plain string instead.
 */
export function useScript<T extends (...args: any[]) => void>(
  fn: T,
  ...args: Parameters<T>
): string {
  const fnStr = fn.toString();
  let minified = cacheGet(fnStr);
  if (minified === undefined) {
    minified = minifyJs(fnStr);
    cacheSet(fnStr, minified);
  }
  const serializedArgs = args.map((a) => JSON.stringify(a)).join(",");
  return `(${minified})(${serializedArgs})`;
}

/**
 * {@link useScript} as a `data:` URI for `<script src="…">`.
 *
 * @deprecated Same hydration issue as {@link useScript}. Use {@link inlineScript} instead.
 */
export function useScriptAsDataURI<T extends (...args: any[]) => void>(
  fn: T,
  ...args: Parameters<T>
): string {
  const code = useScript(fn, ...args);
  return `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;
}

/**
 * Props for a `<script>` element running `js` as is:
 * `<script {...inlineScript(CODE)} />`.
 */
export function inlineScript(js: string) {
  return { dangerouslySetInnerHTML: { __html: js } } as const;
}
