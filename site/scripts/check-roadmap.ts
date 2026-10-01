/**
 * The Roadmap's self-checks (a port of the former Python Roadmap generator's). Run by `bun run check` and at the
 * start of `bun run build`; fails loudly when the data doesn't hold together.
 *
 *  1. Data (components/roadmap/model.ts throws): statuses, sections, unknown ids, broken references,
 *     the counts and links the copy depends on.
 *  2. The rendered pages: every section is rendered with React (as the app renders it) and the
 *     markup checked: wording, labels, ids (unique, and each on the page its URL says), the to-do,
 *     note, detail-list, row and tag counts, section counts, and every internal link.
 *  3. Links from the docs into the Roadmap (`/roadmap#id`, `/roadmap/<section>#id` in content/):
 *     the id exists, on the page the link resolves to.
 *
 * Links into docs pages that don't exist (content/next/<id>.mdx) fail too, unless DOCS_LINKS=warn
 * (as for the post-build link check). Prints a summary.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import data from '../data/roadmap.json'
import { loadManifest, manifestPaths } from '../build/manifest.ts'
import { createRoadmap, docLabelsFromManifest, plain, RoadmapDataError, unescapeHtml, VC, type Roadmap, type RoadmapData } from '../components/roadmap/model.ts'
import { sectionView } from '../components/roadmap/SectionViews.tsx'
import { roadmapTarget, SECTION_IDS, SECTION_NAV, sectionForSlug, sectionOfId, sectionPath, type SectionId } from '../components/roadmap/sections.ts'
import { SITE_ROOT } from './site-files.ts'

const problems: string[] = []
const check = (cond: unknown, msg: string) => {
  if (!cond) problems.push(msg)
}
const fail = () => {
  if (!problems.length) return
  console.error(`${problems.length} roadmap problem${problems.length === 1 ? '' : 's'}:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
  process.exit(1)
}

// ------------------------------------------------------------------------------ 1. data
const manifest = loadManifest(SITE_ROOT)
let rm: Roadmap
try {
  rm = createRoadmap(data as unknown as RoadmapData, { docs: docLabelsFromManifest(manifest), base: '/' })
} catch (e) {
  if (e instanceof RoadmapDataError) {
    console.error(e.message)
    process.exit(1)
  }
  throw e
}

// sections.ts keeps a copy of the sidebar labels (for document titles without the data).
for (const id of SECTION_IDS)
  check(SECTION_NAV[id] === rm.SEC[id].nav, `sections.ts SECTION_NAV['${id}'] is ${JSON.stringify(SECTION_NAV[id])}, data/roadmap.json says ${JSON.stringify(rm.SEC[id].nav)}`)

// ------------------------------------------------------------------------------ 2. rendered pages
const pages = new Map<SectionId, string>(SECTION_IDS.map((id) => [id, renderToStaticMarkup(sectionView(rm, id).article)]))
const out = [...pages.values()].join('\n')
const text = unescapeHtml(out.replace(/<[^>]+>/g, ' '))
const near = (re: RegExp) => [...text.matchAll(new RegExp(`.{0,40}(?:${re.source}).{0,40}`, `g${re.flags.replace('g', '')}`))].slice(0, 5).map((m) => m[0])

// Wording: these docs are the spec here, anchors are links not "#ids", and no undefined abbreviations.
for (const [re, what] of [
  [/\bspec\b/i, "'spec'"],
  [/(?<![\w&])#[a-z]/, 'a bare #anchor'],
  [/\b(?:IS|hCMS|ALS)\b|N\/A/, 'an undefined abbreviation'],
] as const)
  check(!re.test(text), `${what} in the page text: ${JSON.stringify(near(re))}`)
check(!out.includes('{{') && !out.includes('}}'), 'an unexpanded {{placeholder}}')

// No "gap" wording as a label: headings, eyebrows, nav names, detail labels, pills, buttons, tags.
const labels = [
  ...[...out.matchAll(/<(h[123])\b[^>]*>(.*?)<\/\1>/g)].map((m) => m[2]),
  ...[...out.matchAll(/<(dt|button|b class="gx-vp"|span class="gx-kind"|i class="gx-tg"|p class="eyebrow")[^>]*>(.*?)<\//g)].map((m) => m[2]),
  ...SECTION_IDS.map((id) => rm.SEC[id].nav),
]
const badLab = labels.filter((x) => /\bgaps?\b/i.test(plain(x)))
check(!badLab.length, `'gap' in a label: ${JSON.stringify(badLab)}`)

// Ids: unique across the Roadmap, and each on the page its URL names (sections.ts derives the
// page from the id, so links to /roadmap#id can be resolved without the data).
const idsOn = new Map<SectionId, Set<string>>()
const seen = new Map<string, SectionId>()
for (const [sec, html] of pages) {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => unescapeHtml(m[1]))
  idsOn.set(sec, new Set(ids))
  for (const id of ids) {
    check(!seen.has(id), `duplicate id ${id} (${seen.get(id)} and ${sec})`)
    seen.set(id, sec)
    check(sectionOfId(id) === sec, `id ${id} is on ${sectionPath(sec)}, but its URL would be ${roadmapTarget(id)?.to ?? '(none)'}`)
  }
  check(html.startsWith(`<article id="${sec}"`), `${sec}: the page's article must carry the section id`)
}

// Every to-do on the pages. The page never shows this sum: the lists overlap (blockers and Studio
// items are delivered by work items; site steps lean on the same work), so each section shows only its own count.
const nNotes = rm.nNotes
const nTodo = rm.TOP.length + rm.STUDIO_NEW.length + rm.STUDIO_LEGACY.length + rm.CHANGES.length + rm.nSteps - nNotes
const TODO = '<li><span class="rm-sr" data-pagefind-ignore="">To do</span><h2 id="'
const todos = [...out.matchAll(/<li><span class="rm-sr"[^>]*>To do<\/span><h2 id="([^"]+)"/g)].map((m) => m[1])
check(todos.length === nTodo && out.split(TODO).length - 1 === nTodo, `to-dos: ${todos.length} rendered, ${nTodo} in the data`)
check(out.split('<li class="rm-note"><span class="rm-sr" data-pagefind-ignore="">Note</span><h2').length - 1 === nNotes, 'notes')
// No row reads as work that was done and undone, and no grand total appears.
check(!new RegExp(`\\b(?:${nTodo}|${nTodo + nNotes})\\b`).test(text), `the page shows a to-do total (${nTodo})`)
check(!/\bWas “/.test(text), "a 'Was “...”' tag")
check(out.split('<dl class="gx-wf">').length - 1 === rm.TOP.length + rm.STUDIO_NEW.length + rm.STUDIO_LEGACY.length + rm.CHANGES.length, 'detail lists')
const rows = [...out.matchAll(/<li id="roadmap-f-([^"]+)"/g)].map((m) => m[1])
check(rows.length === rm.FIDS.length && new Set(rows).size === rm.FIDS.length && rm.FIDS.every((f) => rows.includes(f)), 'feature rows')
const rowV: Record<string, number> = {}
for (const m of out.matchAll(/<li id="roadmap-f-[^"]+" data-v="([^"]+)"/g)) rowV[m[1]] = (rowV[m[1]] ?? 0) + 1
const wantV = Object.fromEntries(Object.entries(rm.TOTALS).filter(([, n]) => n).map(([k, n]) => [VC[k], n]))
check(JSON.stringify(Object.entries(rowV).sort()) === JSON.stringify(Object.entries(wantV).sort()), `row statuses: ${JSON.stringify(rowV)}`)

// Chips: every list has at least one chip, and each names a feature row.
const chipLists = [...out.matchAll(/<div class="gx-chips"[^>]*>(.*?)<\/div>/g)].map((m) => m[1])
check(chipLists.length === out.split('class="gx-chips"').length - 1 && chipLists.every((c) => c.includes('<a ')), 'empty chip lists')
const chipTargets = chipLists.flatMap((c) => [...c.matchAll(/href="\/roadmap\/features#roadmap-f-([^"]+)"/g)].map((m) => m[1]))
check(chipTargets.length && chipTargets.every((t) => t in rm.FEATS), 'chip targets')

const nTags: Record<string, number> = {}
for (const m of out.matchAll(/<i class="gx-tg"[^>]*>([A-Z][a-z]+)/g)) nTags[m[1]] = (nTags[m[1]] ?? 0) + 1
const F = Object.values(rm.FEATS)
check(
  (nTags.Medium ?? 0) === F.filter((f) => f.confidence !== 'high').length &&
    (nTags.Rated ?? 0) === F.filter((f) => f.rated_before_review).length &&
    (nTags.Unconfirmed ?? 0) === F.filter((f) => f.unconfirmed_sub_claim).length &&
    (nTags.First ?? 0) === F.filter((f) => f.first_rated).length,
  `row tags: ${JSON.stringify(nTags)}`,
)
const countsBySec: Record<string, string> = {}
for (const [sec, html] of pages) {
  const m = /^<article[^>]*><p class="eyebrow">[^<]*<span class="rm-count"[^>]*>([^<]+)<\/span>/.exec(html)
  if (m) countsBySec[sec] = m[1]
}
check(JSON.stringify(Object.keys(countsBySec)) === JSON.stringify(SECTION_IDS.slice(1)), 'every section but the overview shows its own count')
// Every "Part of blocker" link is a blocker whose "Delivered by" names that work item, and back.
check([...rm.CLEARS.values()].reduce((n, v) => n + v.length, 0) === rm.TOP.reduce((n, b) => n + b.delivered_by.length, 0), 'blocker back-links')

// Every internal link resolves: Roadmap links to an id on the page they name, docs links to a page.
const docPaths = new Set(manifestPaths(manifest))
let nLinks = 0
const docLinks = new Set<string>()
for (const [sec, html] of pages) {
  for (const m of html.matchAll(/<a\b[^>]*?\shref="([^"]*)"/g)) {
    const href = unescapeHtml(m[1])
    nLinks++
    const [p, frag] = href.split('#') as [string, string | undefined]
    if (p === '') {
      check(frag && idsOn.get(sec)!.has(frag), `${sectionPath(sec)}: link to #${frag}: no such id on the page`)
    } else if (p.startsWith('/roadmap/')) {
      const target = sectionForSlug(p)
      check(target, `${sectionPath(sec)}: link to ${href}: no such Roadmap page`)
      if (target && frag) check(idsOn.get(target)!.has(frag), `${sectionPath(sec)}: link to ${href}: no #${frag} on that page`)
    } else if (p.startsWith('/next/')) {
      docLinks.add(p.slice('/next/'.length))
      if (!docPaths.has(p)) rm.docProblems.add(`${sectionPath(sec)}: link to ${href}: no such docs page`)
    } else check(/^[a-z]+:/.test(href), `${sectionPath(sec)}: unexpected link ${href}`)
  }
}

// ------------------------------------------------------------------------------ 3. docs -> Roadmap
const contentFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? contentFiles(path.join(dir, e.name)) : e.name.endsWith('.mdx') ? [path.join(dir, e.name)] : []))
let nIn = 0
for (const file of contentFiles(path.join(SITE_ROOT, 'content'))) {
  const src = readFileSync(file, 'utf8')
  const rel = path.relative(SITE_ROOT, file)
  for (const m of [...src.matchAll(/\]\((\/roadmap[^)\s]*)\)/g), ...src.matchAll(/href="(\/roadmap[^"]*)"/g)]) {
    nIn++
    const [p, frag] = m[1].split('#') as [string, string | undefined]
    const page = p === '/roadmap' ? (frag ? sectionOfId(frag) : 'roadmap') : sectionForSlug(p)
    if (!page) {
      problems.push(`${rel}: link to ${m[1]}: no such Roadmap page or id`)
      continue
    }
    if (frag && !idsOn.get(page)!.has(frag)) problems.push(`${rel}: link to ${m[1]}: no #${frag} on ${sectionPath(page)}`)
  }
}

// ------------------------------------------------------------------------------ result
if (rm.docProblems.size) {
  const list = [...rm.docProblems].map((p) => `docs: ${p}`)
  if (process.env.DOCS_LINKS === 'warn') console.warn(`${list.length} roadmap link${list.length === 1 ? '' : 's'} into missing docs pages:\n${list.map((p) => `  - ${p}`).join('\n')}`)
  else problems.push(...list)
}
fail()

const vlabel = (k: string) => rm.VLABEL(k)
console.log(
  `roadmap: ok — ${SECTION_IDS.length} pages: ${SECTION_IDS.map((s) => `${sectionPath(s)}${countsBySec[s] ? ` [${countsBySec[s]}]` : ''}`).join(', ')}`,
)
console.log(
  `  to-dos: ${todos.length} (blockers ${rm.TOP.length}, studio ${rm.STUDIO_NEW.length}+${rm.STUDIO_LEGACY.length}, work items ${rm.CHANGES.length}, site steps ${rm.REPOS.map((r) => rm.PLAN[r].length).join('+')})  rows: ${rows.length}  chips: ${chipTargets.length}  internal links: ${nLinks}  links in from the docs: ${nIn}`,
)
console.log(
  `  statuses: ${JSON.stringify(Object.fromEntries(Object.entries(rm.TOTALS).map(([k, v]) => [vlabel(k), v])))}  row tags: ${JSON.stringify(nTags)}`,
)
console.log(`  links into the docs: ${[...docLinks].sort().join(', ')}`)
