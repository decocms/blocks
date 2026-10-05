#!/usr/bin/env node
// Where do the bytes of a storefront page go? Zero dependencies (Node 18+).
//
//   node html-anatomy.mjs https://www.example.com/category
//   node html-anatomy.mjs ./saved-page.html
//
// Prints: raw/gzip size, cache headers (URL mode), bytes per attribute, the
// analytics `data-event` / `data-dt-event` breakdown, and every large blob
// (attribute value or inline script) that appears more than once — the usual
// culprit is the same payload emitted per card, per size or per instance.

import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const target = process.argv[2];
if (!target) {
  console.error("usage: node html-anatomy.mjs <url|file>");
  process.exit(1);
}

let html;
if (/^https?:\/\//.test(target)) {
  const res = await fetch(target, {
    headers: { "user-agent": "Mozilla/5.0 (Macintosh) Chrome/140", accept: "text/html" },
  });
  html = await res.text();
  for (const h of ["cache-control", "cf-cache-status", "age", "x-cache", "x-cache-segment", "x-cache-store", "set-cookie"]) {
    const v = res.headers.get(h);
    if (v) console.log(`${h}: ${v.slice(0, 120)}`);
  }
} else {
  html = readFileSync(target, "utf8");
}

const kb = (n) => `${(n / 1024).toFixed(0).padStart(7)} KB`;
const raw = Buffer.byteLength(html);
console.log(`\ntotal ${kb(raw)} raw, ${kb(gzipSync(html).length)} gzip\n`);

const byAttr = new Map();
const blobs = new Map();
// Group by the first 200 chars: repeated payloads usually differ only in a
// trailing id/props (e.g. the same script inlined per instance with its rootId).
const note = (key, value) => {
  if (value.length < 1024) return;
  const sig = `${key}|${value.slice(0, 200)}`;
  const e = blobs.get(sig) ?? { key, n: 0, bytes: 0, sample: value };
  e.n++;
  e.bytes += value.length;
  blobs.set(sig, e);
};
for (const m of html.matchAll(/\s([a-zA-Z:@\-]+)="([^"]*)"/g)) {
  byAttr.set(m[1], (byAttr.get(m[1]) ?? 0) + m[2].length);
  note(m[1], m[2]);
}
for (const m of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
  byAttr.set("<script> body", (byAttr.get("<script> body") ?? 0) + m[1].length);
  note("<script> body", m[1]);
}

console.log("bytes by attribute (top 12):");
for (const [k, v] of [...byAttr].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${k.padEnd(24)}${kb(v)}  ${((v / raw) * 100).toFixed(0)}%`);
}

const events = new Map();
for (const m of html.matchAll(/\sdata-(?:dt-)?event="([^"]*)"/g)) {
  let name = "?";
  try {
    const d = JSON.parse(decodeURIComponent(m[1].replace(/&quot;/g, '"')));
    name = d.name ?? d.event ?? "?";
  } catch {}
  const e = events.get(name) ?? { n: 0, bytes: 0 };
  e.n++;
  e.bytes += m[1].length;
  events.set(name, e);
}
if (events.size) {
  console.log("\nanalytics events in markup:");
  for (const [k, e] of [...events].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 8)) {
    console.log(`  ${String(k).padEnd(24)}${String(e.n).padStart(5)}x ${kb(e.bytes)}`);
  }
}

const dupes = [...blobs.values()].filter((e) => e.n > 1).sort((a, b) => b.bytes - a.bytes);
if (dupes.length) {
  console.log("\nlarge blobs repeated (same first 200 chars) — fix: emit once, reference it:");
  for (const e of dupes.slice(0, 8)) {
    console.log(`  ${String(e.n).padStart(4)}x ~${kb(e.bytes / e.n)} each = ${kb(e.bytes)}  [${e.key}] ${e.sample.slice(0, 60).replace(/\s+/g, " ")}…`);
  }
}
