import { F_PROPS_COUNT, F_PROPS_LEN, F_PROPS_TYPE, LIMITS } from "../../shared/contract.ts";

/** The client's share of the contract, kept to the two violations that actually cost
 *  upload bytes: an oversized value and a non-primitive that would be serialised whole.
 *
 *  Everything else — charset, reserved names, currency, timestamps — is left to the
 *  Worker. Shipping the full normaliser cost 2.3 KB minified in every visitor's download
 *  to save bytes on payloads most sites never send, which is the wrong trade. The Worker
 *  is the authority regardless, so the client's job is bandwidth, not correctness.
 *
 *  What a developer loses by not normalising here is visibility, and that comes back the
 *  cheaper way: with `debug()` on, the collect response echoes the flags the Worker
 *  applied. Zero bytes in the normal path, full feedback when someone is looking. */
export function trimProps(input: unknown, flag: (f: string) => void): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;

  let n = 0;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (n >= LIMITS.propKeys) {
      flag(F_PROPS_COUNT);
      break;
    }
    if (v === null || v === undefined) continue;

    const t = typeof v;
    if (t !== "string" && t !== "number" && t !== "boolean") {
      flag(F_PROPS_TYPE);
      continue;
    }

    out[k] =
      t === "string" && (v as string).length > LIMITS.valueLen
        ? (flag(F_PROPS_LEN), (v as string).slice(0, LIMITS.valueLen))
        : v;
    n++;
  }
  return out;
}
