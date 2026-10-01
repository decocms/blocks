/**
 * The Roadmap's data model: data/roadmap.json, checked and turned into what the pages render.
 * A port of the former Python Roadmap generator's data layer (removed). Pure (no React, no router, no Vite), so the app,
 * scripts/check-roadmap.ts and vite.config.ts can all use it.
 *
 * Data errors (unknown ids, broken references, counts the copy depends on) throw a RoadmapDataError
 * with the old script's messages, which fails the build. Links into the docs that don't resolve to
 * a page yet are collected in `docProblems` instead (the docs are ported page by page), and
 * scripts/check-roadmap.ts reports them.
 *
 * HTML fields of the data (titles, Today/Plan text, the overview copy) may contain `<code>`, links
 * and `{{item:ID}}`. Links are written as the old single page's `#id` and rewritten here to real
 * URLs (see sections.ts): `#roadmap-…` to the Roadmap page holding that id, anything else to the
 * docs page of the next major (`#studio` -> /next/studio, `#releases--publishing` ->
 * /next/releases#publishing).
 */
import { docsHref, roadmapHref, SECTION_IDS, type SectionId } from './sections'

// ------------------------------------------------------------------------------ data shapes
export interface StatusData {
  id: string
  label: string
  word: string
  word_one: string
  tile: string
  legend: string
}
export interface SectionData {
  id: SectionId
  nav: string
  eyebrow: string
  title: string
}
export interface FeatureData {
  name: string
  category: string
  status: string
  effort: 'L' | 'M' | 'S'
  sites: string[]
  summary: string
  docs: string[]
  confidence: string
  first_rated: string | null
  rated_before_review: string | null
  unconfirmed_sub_claim: boolean
}
export interface BlockerData {
  id: string
  title: string
  today: string
  plan: string
  features: string[]
  delivered_by: string[]
  delivered_note?: string
}
export interface StudioItemData {
  id: string
  title: string
  today: string
  features: string[]
  delivered_by: string[]
}
export interface WorkItemData {
  id: string
  group: 'api' | 'cli' | 'studio' | 'docs'
  title: string
  plan: string
  features: string[]
  docs: string[]
  pinned?: boolean
}
export interface StepData {
  id: string
  kind: keyof typeof KIND
  title: string
  text: string
  features: string[]
  no_action: boolean
}
export interface SiteData {
  id: string
  name: string
  short: string
  section: SectionId
  description: string
  headline: string
  steps: StepData[]
}
export interface CategoryData {
  id: string
  title: string
  description: string
}
export interface RoadmapData {
  statuses: StatusData[]
  sections: SectionData[]
  overview: { intro: string; readiness_lead: string; fix_docs: string; fix_now?: string }
  blockers: BlockerData[]
  studio_new: StudioItemData[]
  studio_legacy: StudioItemData[]
  work_items: WorkItemData[]
  sites: SiteData[]
  categories: CategoryData[]
  features: Record<string, FeatureData>
}

// ------------------------------------------------------------------------------ constants
/** Work-item groups -> their sections. */
export const GROUP_SEC = { api: 'roadmap-api', cli: 'roadmap-cli', studio: 'roadmap-platform', docs: 'roadmap-docs' } as const
export type WorkGroup = keyof typeof GROUP_SEC
/** Status id -> the one-letter hook the styles colour by (data-v="…" in roadmap.css). */
export const VC: Record<string, string> = { 'to-build': 'g', 'to-finish': 'p', 'site-code': 'a', done: 'c', 'goes-away': 'n' }
/** Statuses that count as open work (the "Open work" effort tally). */
export const OPEN = new Set(['to-build', 'to-finish', 'site-code'])
/** Site-step kinds. The site-migration lede names these labels. */
export const KIND = { now: 'Fix now', pre: 'Before migrating', blocker: 'Blocker', work: 'Site work', content: 'Content', fix: 'Note' } as const
export const EFF_RANK: Record<string, number> = { L: 0, M: 1, S: 2 }
/** The page says "the ten release blockers" in several places. */
export const N_BLOCKERS = 10

export class RoadmapDataError extends Error {}

export function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new RoadmapDataError(`roadmap: ${msg}`)
}

// ------------------------------------------------------------------------------ text helpers
export const esc = (s: string) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
export const unescapeHtml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITIES[e.toLowerCase()] ?? m),
  )

/** Visible text of an HTML fragment. */
export const plain = (s: string) => unescapeHtml(s.replace(/<[^>]+>/g, ''))

/** Same rule as the docs' heading slugs (build/slugify.ts), applied to plain text. */
export function slug(text: string): string {
  return (
    plain(text)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  )
}

/** `<code>` of at most 24 characters gets `class="is-short"` (white-space: nowrap in legacy.css). */
export const shortCode = (html: string) =>
  html.replace(/<code>([\s\S]*?)<\/code>/g, (m, inner: string) => (plain(inner).trim().length <= 24 ? `<code class="is-short">${inner}</code>` : m))

// ------------------------------------------------------------------------------ the model
export interface DocPageInfo {
  /** The docs page's sidebar label (the old data-nav). */
  label: string
}

export interface RoadmapOptions {
  /**
   * The next major's docs pages by old section id (= file name): `studio` -> its label. Built from
   * the content manifest (docLabelsFromManifest). Ids missing here are reported in docProblems.
   */
  docs: Map<string, DocPageInfo>
  /** Base path prepended to every internal link ("/" or "/blocks/"). */
  base?: string
}

export interface BackLink {
  /** Roadmap id of the blocker or work item. */
  id: string
  /** Blocker number (1-based), for blockers. */
  n?: number
  title: string
}

export type Roadmap = ReturnType<typeof createRoadmap>

export function createRoadmap(input: RoadmapData, opts: RoadmapOptions) {
  // Titles and HTML fields get rewritten below; never touch the caller's (imported) object.
  const d: RoadmapData = structuredClone(input)
  const base = opts.base ?? '/'
  const docProblems = new Set<string>()

  // --- links -------------------------------------------------------------------------------
  /** An internal link target: Roadmap ids to their page, anything else to the docs. */
  const hrefOf = (id: string): string => {
    const rm = roadmapHref(id)
    if (rm) return base + rm.slice(1)
    const page = id.split('--')[0]
    if (!opts.docs.has(page)) docProblems.add(`link to #${id}: no docs page "${page}" (content/next/${page}.mdx)`)
    return base + docsHref(id).slice(1)
  }
  /**
   * Rewrites the old `href="#id"` links of an HTML field to real URLs, and marks short inline code
   * (≤ 24 characters) `is-short` so it never wraps, as the old page script did for every section.
   */
  const links = (html: string) => shortCode(html).replace(/href="#([^"]*)"/g, (_, id: string) => `href="${hrefOf(id)}"`)

  // --- statuses ----------------------------------------------------------------------------
  const VERDICTS = d.statuses.map((s) => s.id)
  check(JSON.stringify(VERDICTS) === JSON.stringify(Object.keys(VC)), `statuses must be ${JSON.stringify(Object.keys(VC))} in that order, got ${JSON.stringify(VERDICTS)}`)
  const ST = Object.fromEntries(d.statuses.map((s) => [s.id, s]))
  for (const s of d.statuses) s.legend = links(s.legend)
  const VLABEL = (v: string) => ST[v].label
  const vword = (v: string, n: number) => (n === 1 ? ST[v].word_one : ST[v].word)
  const vq = (v: string) => `“${ST[v].word_one}”`

  // --- titles ------------------------------------------------------------------------------
  const checkTitle = (t: string, where: string) => {
    // Titles are HTML: plain text, entities and <code> only.
    const rest = t.replace(/<\/?code>/g, '')
    check(t && t.trim() === t, `${where}: empty title or stray whitespace`)
    check(!/[<>]|&(?!(?:amp|lt|gt|quot|#\d+);)/.test(rest), `${where}: title has markup other than <code>: ${JSON.stringify(t)}`)
  }

  // --- sections ----------------------------------------------------------------------------
  check(JSON.stringify(d.sections.map((s) => s.id)) === JSON.stringify(SECTION_IDS), "sections must list the page's section ids in order")
  for (const s of d.sections) {
    check(s.nav && s.eyebrow, `section ${s.id} needs nav and eyebrow`)
    checkTitle(s.title, `section ${s.id}`)
  }
  const SEC = Object.fromEntries(d.sections.map((s) => [s.id, s])) as Record<SectionId, SectionData>

  // --- features ----------------------------------------------------------------------------
  const CATS = d.categories
  const catIds = new Set(CATS.map((c) => c.id))
  const FEATS = d.features
  const FIDS = Object.keys(FEATS)
  const REPOS = d.sites.map((s) => s.id)
  for (const [fid, f] of Object.entries(FEATS)) {
    check(catIds.has(f.category), `feature ${fid}: unknown category ${JSON.stringify(f.category)}`)
    check(f.status in VC, `feature ${fid}: unknown status ${JSON.stringify(f.status)}`)
    check(f.effort in EFF_RANK, `feature ${fid}: effort must be L, M or S`)
    check(f.sites.length && f.sites.every((s) => REPOS.includes(s)), `feature ${fid}: unknown sites ${JSON.stringify(f.sites)}`)
    for (const k of ['first_rated', 'rated_before_review'] as const) check(f[k] === null || f[k]! in VC, `feature ${fid}: ${k} must be a status id or null`)
    // Every feature names at least one part of these docs.
    check(f.docs.length, `feature ${fid}: no docs ids`)
    check(!/[<>]/.test(f.name), `feature ${fid}: the name is plain text`)
  }
  const counts = (ids: string[]): [string, number][] => {
    const c: Record<string, number> = {}
    for (const i of ids) c[FEATS[i].status] = (c[FEATS[i].status] ?? 0) + 1
    return VERDICTS.map((v) => [v, c[v] ?? 0])
  }
  const TOTALS = Object.fromEntries(counts(FIDS)) as Record<string, number>
  const REPO_IDS = Object.fromEntries(REPOS.map((r) => [r, FIDS.filter((fid) => FEATS[fid].sites.includes(r))]))

  const SHORT = Object.fromEntries(d.sites.map((s) => [s.id, s.short]))
  /** The name the page shows for a site (bars, the intro's links, the site filter's tooltip). */
  const NAME = Object.fromEntries(d.sites.map((s) => [s.id, s.name]))
  for (const s of d.sites) check(!/[<>&]/.test(s.name + s.short), `site ${s.id}: name and short are plain text`)
  const SITE_SEC = Object.fromEntries(d.sites.map((s) => [s.id, s.section])) as Record<string, SectionId>
  check(
    JSON.stringify(Object.values(SITE_SEC)) === JSON.stringify(['roadmap-storefront', 'roadmap-blog', 'roadmap-faststore']),
    'sites must map, in order, to the roadmap-storefront, roadmap-blog and roadmap-faststore sections',
  )
  const REPO_DESC = Object.fromEntries(d.sites.map((s) => [s.id, links(s.description)]))

  // --- to-dos: every one has an explicit id (its anchor); titles are looked up by id ---------
  const TITLE = new Map<string, string>()
  const checkFeatures = (ids: string[], where: string) => {
    const bad = ids.filter((i) => !(i in FEATS))
    check(ids.length && !bad.length, `${where}: unknown or missing feature ids ${JSON.stringify(bad)}`)
  }
  const reg = (item: { id: string; title: string; features: string[] }, prefix: string, what: string) => {
    check(item.id.startsWith(`${prefix}--`), `${what} ${JSON.stringify(item.id)} must start with ${prefix}--`)
    check(!TITLE.has(item.id), `duplicate id ${JSON.stringify(item.id)}`)
    checkTitle(item.title, `${what} ${item.id}`)
    checkFeatures(item.features, `${what} ${item.id}`)
    TITLE.set(item.id, item.title)
  }

  const TOP = d.blockers
  for (const b of TOP) reg(b, 'roadmap-blockers', 'blocker')
  check(TOP.length === N_BLOCKERS, `the page says 'ten release blockers'; the data has ${TOP.length}`)
  const STUDIO_NEW = d.studio_new
  const STUDIO_LEGACY = d.studio_legacy
  for (const x of STUDIO_NEW) reg(x, 'roadmap-studio-new', 'Studio item')
  for (const x of STUDIO_LEGACY) reg(x, 'roadmap-studio-legacy', 'Studio item')
  const CHANGES = d.work_items
  for (const c of CHANGES) {
    check(c.group in GROUP_SEC, `work item ${c.id}: unknown group ${JSON.stringify(c.group)}`)
    reg(c, GROUP_SEC[c.group], 'work item')
  }
  const WORK = new Map(CHANGES.map((c) => [c.id, c]))
  const PLAN: Record<string, StepData[]> = {}
  /** step id -> its site, number and step. */
  const STEP = new Map<string, { site: string; n: number; step: StepData }>()
  for (const s of d.sites) {
    PLAN[s.id] = s.steps
    s.steps.forEach((step, i) => {
      reg(step, s.section, 'site step')
      check(step.kind in KIND, `site step ${step.id}: unknown kind ${JSON.stringify(step.kind)}`)
      // A Note with nothing to do (the migration removes it) is drawn without a box and isn't counted.
      check(!step.no_action || step.kind === 'fix', `site step ${step.id}: only a Note can carry no action`)
      STEP.set(step.id, { site: s.id, n: i + 1, step })
    })
  }

  // Titles were checked as written; from here on they carry the is-short class on short code.
  for (const s of d.sections) s.title = shortCode(s.title)
  for (const item of [...TOP, ...STUDIO_NEW, ...STUDIO_LEGACY, ...CHANGES, ...[...STEP.values()].map((x) => x.step)]) {
    item.title = shortCode(item.title)
    TITLE.set(item.id, item.title)
  }

  // Work items delivering each blocker (each is one part of it, not all of it), and back.
  const CLEARS = new Map<string, number[]>()
  TOP.forEach((b, i) => {
    for (const k of b.delivered_by) {
      check(WORK.has(k), `blocker ${b.id}: delivered_by ${JSON.stringify(k)} is not a work item`)
      CLEARS.set(k, [...(CLEARS.get(k) ?? []), i + 1])
    }
  })
  // Studio items point to work items or site steps; a pointer must share at least one feature with the item.
  for (const x of [...STUDIO_NEW, ...STUDIO_LEGACY]) {
    for (const ref of x.delivered_by) {
      check(WORK.has(ref) || STEP.has(ref), `Studio item ${x.id}: delivered_by ${JSON.stringify(ref)} is not a work item or site step`)
      const ids = WORK.get(ref)?.features ?? STEP.get(ref)!.step.features
      check(
        ids.some((i) => x.features.includes(i)),
        `Studio item ${x.id}: ${JSON.stringify(ref)} shares no feature with it`,
      )
    }
  }

  // {{item:ID}} in any HTML field becomes a link to that to-do, named by its current title; then
  // every #id link becomes a real URL.
  const expand = (s: string) =>
    links(
      s.replace(/\{\{item:([a-z0-9-]+)\}\}/g, (_, id: string) => {
        check(TITLE.has(id), `{{item:${id}}} names no to-do`)
        return `<a href="#${id}">${TITLE.get(id)}</a>`
      }),
    )
  const html = {
    blocker: new Map(TOP.map((b) => [b.id, { today: expand(b.today), plan: expand(b.plan), note: b.delivered_note ? expand(b.delivered_note) : '' }])),
    studio: new Map([...STUDIO_NEW, ...STUDIO_LEGACY].map((x) => [x.id, { today: expand(x.today) }])),
    work: new Map(CHANGES.map((c) => [c.id, { plan: expand(c.plan) }])),
    step: new Map([...STEP.values()].map(({ step }) => [step.id, { text: expand(step.text) }])),
  }
  const HEADLINE = Object.fromEntries(d.sites.map((s) => [s.id, expand(s.headline)]))
  const OV = Object.fromEntries(Object.entries(d.overview).map(([k, v]) => [k, expand(v)])) as RoadmapData['overview']
  /** A to-do's title (HTML: text and <code>). */
  const title = (id: string) => TITLE.get(id)!

  // The intro is a run of paragraphs (the first is the page's lede).
  const introParagraphs = [...OV.intro.trim().matchAll(/<p>([\s\S]*?)<\/p>/g)].map((x) => x[1])
  check(introParagraphs.length && OV.intro.trim().replace(/<p>[\s\S]*?<\/p>/g, '').trim() === '', 'overview.intro must be one or more <p> paragraphs')

  // The overview's intro and readiness line are copy; fail if the numbers or links move under them.
  OV.intro = OV.intro.trim()
  OV.readiness_lead = OV.readiness_lead.trim()
  for (const s of [
    ...REPOS.map((r) => `<a href="${hrefOf(SITE_SEC[r])}">${NAME[r]}</a>`),
    `The <a href="${hrefOf('roadmap-blockers')}">ten release blockers</a> gate the release`,
    `<a href="${hrefOf('roadmap--release-readiness')}">Release readiness</a>`,
  ])
    check(OV.intro.includes(s), `overview.intro must contain ${JSON.stringify(s)}`)
  for (const s of [
    `None of the ${FIDS.length} features`,
    `${TOTALS['to-build']} are still to build`,
    `${TOTALS['to-finish']} are to finish`,
    `${TOTALS['site-code']} are left to site code`,
    `${TOTALS['goes-away']} go away`,
  ])
    check(OV.readiness_lead.includes(s), `overview.readiness_lead must contain ${JSON.stringify(s)} (the counts come from the features)`)

  // Docs ids: every one must be a page of the next major.
  const docLabel = (id: string): string => {
    return opts.docs.get(id)?.label ?? id
  }
  for (const [fid, f] of Object.entries(FEATS)) for (const x of f.docs) if (!opts.docs.has(x)) docProblems.add(`feature ${fid}: docs id "${x}" has no page (content/next/${x}.mdx)`)
  for (const c of CHANGES) for (const x of c.docs) if (!opts.docs.has(x)) docProblems.add(`work item ${c.id}: docs id "${x}" has no page (content/next/${x}.mdx)`)

  // --- derived lists -----------------------------------------------------------------------
  const sitesOf = (ids: string[]) => REPOS.filter((r) => ids.some((x) => FEATS[x].sites.includes(r)))
  const allSitesBlockers = TOP.every((g) => JSON.stringify(sitesOf(g.features)) === JSON.stringify(REPOS))

  /** A group's work items: pinned first (data order), then by how many features need them. */
  const workItems = (key: WorkGroup) => {
    const items = CHANGES.filter((c) => c.group === key)
      .map((c, i) => ({ c, k: c.pinned ? [0, 0, i] : [1, -c.features.length, i] }))
      .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2])
      .map((x) => x.c)
    const nPinned = items.filter((c) => c.pinned).length
    check((key === 'docs' && nPinned === 2) || (key !== 'docs' && nPinned === 0), 'exactly two docs work items are pinned (the docs lede says so), and no other')
    return items
  }
  const WORK_BY_GROUP = Object.fromEntries((Object.keys(GROUP_SEC) as WorkGroup[]).map((k) => [k, workItems(k)])) as Record<WorkGroup, WorkItemData[]>

  /**
   * Feature -> the release blockers and work items whose chips name it ("Addressed by"), in page
   * order: blockers, then the work-item sections (each in its rendered order).
   */
  const BACK = new Map<string, BackLink[]>()
  const addBack = (fid: string, b: BackLink) => BACK.set(fid, [...(BACK.get(fid) ?? []), b])
  TOP.forEach((b, i) => b.features.forEach((f) => addBack(f, { id: b.id, n: i + 1, title: b.title })))
  for (const key of ['api', 'cli', 'studio', 'docs'] as const) for (const c of WORK_BY_GROUP[key]) c.features.forEach((f) => addBack(f, { id: c.id, title: c.title }))

  /** Features in a category, in the readiness order: status rank, effort, name. */
  const VRANK = Object.fromEntries(VERDICTS.map((v, i) => [v, i]))
  const featuresIn = (cat: string) =>
    FIDS.filter((fid) => FEATS[fid].category === cat).sort((a, b) => {
      const fa = FEATS[a]
      const fb = FEATS[b]
      return VRANK[fa.status] - VRANK[fb.status] || EFF_RANK[fa.effort] - EFF_RANK[fb.effort] || (fa.name < fb.name ? -1 : fa.name > fb.name ? 1 : 0)
    })

  /** `code` and [label](#id) links in a feature summary (escaped first). */
  const md = (s: string) =>
    links(
      esc(s)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\[([^\]]+)\]\(#([a-z0-9-]+)\)/g, '<a href="#$2">$1</a>'),
    )

  const feature = (fid: string) => {
    const f = FEATS[fid]
    return { id: fid, ...f, v: VC[f.status], summaryHtml: md(f.summary), docLinks: f.docs.map((x) => ({ href: hrefOf(x), label: docLabel(x) })) }
  }

  const nSteps = Object.values(PLAN).reduce((n, s) => n + s.length, 0)
  const nNotes = Object.values(PLAN).reduce((n, s) => n + s.filter((x) => x.no_action).length, 0)

  return {
    data: d,
    base,
    docProblems,
    hrefOf,
    links,
    expand,
    VERDICTS,
    VLABEL,
    vword,
    vq,
    status: (v: string) => ST[v],
    SEC,
    CATS,
    FEATS,
    FIDS,
    REPOS,
    TOTALS,
    REPO_IDS,
    SHORT,
    NAME,
    SITE_SEC,
    REPO_DESC,
    HEADLINE,
    OV,
    introParagraphs,
    TOP,
    STUDIO_NEW,
    STUDIO_LEGACY,
    CHANGES,
    WORK,
    WORK_BY_GROUP,
    PLAN,
    STEP,
    CLEARS,
    BACK,
    html,
    title,
    docLabel,
    counts,
    sitesOf,
    allSitesBlockers,
    featuresIn,
    feature,
    nSteps,
    nNotes,
  }
}

/** Docs labels from the content manifest: the next major's pages, by file name. */
export function docLabelsFromManifest(manifest: {
  versions: Record<string, { pages: { slug: string; nav: string; kind: string }[] } | undefined>
}): Map<string, DocPageInfo> {
  const pages = manifest.versions.next?.pages ?? []
  // The Under-the-hood overview's sidebar label is "Overview"; the Roadmap names it by its tab.
  return new Map(pages.filter((p) => p.slug).map((p) => [p.slug, { label: p.kind === 'internals' && p.nav === 'Overview' ? 'Under the hood' : p.nav }]))
}
