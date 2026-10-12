/**
 * Network reads the SDK makes on its own (hosted releases, draft changes):
 * a timeout on the whole request, and a JSON body refused as soon as it
 * would exceed a size, before it's buffered whole (a Worker isolate has
 * 128 MB).
 */

/** An abort signal that fires after `ms`, where the runtime has `AbortSignal.timeout`. */
export function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(ms)
    : undefined;
}

/** Parses a JSON body, refusing it once it passes `maxBytes`. */
export async function readBoundedJson(
  response: Response,
  label: string,
  maxBytes: number,
): Promise<unknown> {
  const tooLarge = () => new Error(`${label}: larger than ${maxBytes} bytes`);
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (response.body === null) {
    const text = await response.text();
    if (text.length > maxBytes) throw tooLarge();
    return JSON.parse(text);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    parts.push(decoder.decode(value, { stream: true }));
  }
  parts.push(decoder.decode());
  return JSON.parse(parts.join(""));
}
