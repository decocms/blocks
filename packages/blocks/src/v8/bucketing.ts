/**
 * The arithmetic behind `@decocms/blocks/experiments`: the hash, the roll and
 * the visitor id. Internal: not in the exports map, so the public surface is
 * `assign` and the cookie helpers alone, and the tests import this by path.
 *
 * A hash bug here fails silently: every visitor still gets an answer, it is
 * just the wrong one, and the test's result is quietly meaningless. That is
 * why `experiments.test.ts` pins MurmurHash3's published vectors and a table
 * of rolls, and why changing anything here moves visitors already allocated.
 */

/** Fills `bytes` with random values. `assign` takes one so tests can pin the id. */
export type RandomBytes = (bytes: Uint8Array<ArrayBuffer>) => void;

const ID_BYTES = 16;

const encoder = new TextEncoder();

/** MurmurHash3 x86 32-bit, seed 0 by default, over `bytes`, as an unsigned 32-bit number. */
export function murmur3_32(bytes: Uint8Array, seed = 0): number {
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  const len = bytes.length;
  const blocks = len & ~3;
  let h = seed >>> 0;

  for (let i = 0; i < blocks; i += 4) {
    let k =
      ((bytes[i] as number) |
        ((bytes[i + 1] as number) << 8) |
        ((bytes[i + 2] as number) << 16) |
        ((bytes[i + 3] as number) << 24)) >>>
      0;
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }

  const tail = len & 3;
  if (tail > 0) {
    let k = 0;
    if (tail === 3) k ^= (bytes[blocks + 2] as number) << 16;
    if (tail >= 2) k ^= (bytes[blocks + 1] as number) << 8;
    k ^= bytes[blocks] as number;
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
  }

  h ^= len;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * This visitor's number for this experiment: a fixed value in [0, 100) with a
 * step of 0.01, the same on every runtime. The visitor is in when it is below
 * the allocation, which is what makes a ramp only ever add people: the roll
 * does not move, the threshold does.
 */
export function roll(name: string, id: string): number {
  return (murmur3_32(encoder.encode(`${name}:${id}`)) % 10000) / 100;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const defaultRandom: RandomBytes = (bytes) => {
  crypto.getRandomValues(bytes);
};

/** A fresh visitor id: 128 bits as 22 base64url characters. */
export function newId(random: RandomBytes = defaultRandom): string {
  const bytes = new Uint8Array(ID_BYTES);
  random(bytes);
  return toBase64Url(bytes);
}
