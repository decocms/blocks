/**
 * The Roadmap's sections, one per page (a port of the former Python Roadmap generator's render functions). Router-free
 * markup: internal links are plain <a href> with the base path, and RoadmapPage turns clicks on
 * them into client-side navigation. That keeps these components renderable on their own, which
 * scripts/check-roadmap.ts does to run the page's self-checks.
 *
 * Levels: the page title is the h1, the sections' sub-headings and to-dos are h2 (the old h3),
 * feature rows are h3 (the old h4). Styled with utilities; the prose layer (.doc-section) gives
 * the h1, lede, sub-headings, paragraphs and links their docs look.
 *
 * Each section returns its article plus its "On this page" entries (`rail`), so the page's outline
 * comes from the data rather than from the DOM.
 */
import { createContext, Fragment, useContext, type ReactNode } from 'react'
import { HeadingAnchor } from '~/components/mdx/Heading'
import { Small } from '~/components/mdx/Small'
import type { RailItem } from '~/src/lib/nav'
import { esc, GROUP_SEC, KIND, OPEN, plain, slug, VC, type Roadmap, type WorkGroup } from './model'
import type { SectionId } from './sections'

// ------------------------------------------------------------------------------ styles
// Status colours: a status (data-v code) sets --vc (marker), --vbg/--vfg (pill) on the element
// that shows it, so one set of utilities (bg-(--vbg), before:bg-(--vc)) draws every status.
const VVARS: Record<string, string> = {
  g: '[--vc:var(--gx-g)] [--vbg:var(--gx-g-bg)] [--vfg:var(--gx-g-fg)]',
  p: '[--vc:var(--gx-p)] [--vbg:var(--gx-p-bg)] [--vfg:var(--gx-p-fg)]',
  a: '[--vc:var(--gx-a)] [--vbg:var(--gx-a-bg)] [--vfg:var(--gx-a-fg)]',
  c: '[--vc:var(--gx-c)] [--vbg:var(--gx-c-bg)] [--vfg:var(--gx-c-fg)]',
  n: '[--vc:var(--gx-n)] [--vbg:var(--gx-n-bg)] [--vfg:var(--gx-n-fg)]',
}
const vvars = (code?: string) => (code ? VVARS[code] : '')
/**
 * The status marker before a label: a dot, or a diamond for "to build" (so red and amber never
 * differ by colour alone). `status-dot` (src/styles/components/docs.css) also sets the status
 * colours from the element's data-v, so its users don't need vvars().
 */
const DOT = 'status-dot'
/** The unchecked to-do box (decorative), on ::before or ::after. */
const BOX_BEFORE = 'before:box-border before:size-[18px] before:flex-none before:rounded-[5px] before:border-[1.5px] before:border-quiet before:bg-surface'
/** A note with nothing to do: a short rule in the box's place. */
const NOTE_MARK = 'before:size-[18px] before:flex-none before:bg-[linear-gradient(var(--quiet),var(--quiet))] before:bg-[length:10px_1.5px] before:bg-center before:bg-no-repeat'
const BOX_AFTER = 'after:box-border after:size-[18px] after:flex-none after:rounded-[5px] after:border-[1.5px] after:border-quiet after:bg-surface'
/** The small uppercase labels (Sites, The site, detail-list labels, filter groups). */
const LABEL = 'text-12 leading-4.5 font-normal tracking-label uppercase text-eyebrow'
/** Links in a run ("Delivered by", "In these docs", …) are set apart by space alone. */
const RUN = '[&>:is(a,span):not(:last-child)]:mr-[.85em]'
/** The to-do callouts on the overview: the callout box model with the to-do box in the icon's place. */
const TODO_CALLOUT = `relative my-7 rounded-box border py-4 pr-[22px] pl-[50px] max-sm:py-3.5 max-sm:pr-4 max-sm:pl-11 print:break-inside-avoid ${BOX_BEFORE} before:absolute before:top-[19px] before:left-5 max-sm:before:top-[17px] max-sm:before:left-[15px]`
const TODO_CALLOUT_P = 'm-0 max-w-none text-15 leading-[25px] text-fg-body'
/** Pills (status, step kind, row tags) keep their fills on paper. */
const PRINT_EXACT = 'print:[print-color-adjust:exact]'

// ------------------------------------------------------------------------------ small parts
/** An element whose content is an HTML field of the data (trusted, from data/roadmap.json). */
function Html({ as: Tag = 'span', html, ...rest }: { as?: 'span' | 'p' | 'dd' | 'a' | 'div'; html: string } & Record<string, unknown>) {
  return <Tag {...rest} dangerouslySetInnerHTML={{ __html: html }} />
}

/** Joins nodes with a separator (" " between links in a run). */
function join(nodes: ReactNode[], sep: ReactNode = ' '): ReactNode[] {
  return nodes.flatMap((n, i) => (i ? [<Fragment key={`s${i}`}>{sep}</Fragment>, <Fragment key={i}>{n}</Fragment>] : [<Fragment key={i}>{n}</Fragment>]))
}

const pad = (n: number) => String(n).padStart(2, '0')

/** A plain sub-heading (h2) with its permalink; text only. */
function SubHeading({ id, className, hidden, children }: { id: string; className?: string; hidden?: boolean; children: string }) {
  return (
    <h2 id={id} aria-label={children} className={className} hidden={hidden}>
      {children}
      <HeadingAnchor id={id} label={children} />
    </h2>
  )
}

/**
 * A to-do's heading: box, (number,) title; everything below hangs under the title's column. The
 * box is decorative (the item's first child says "To do" to screen readers); a note with nothing
 * to do gets a short rule in its place.
 */
function TodoHeading({ id, title, n, note }: { id: string; title: string; n?: number; note?: boolean }) {
  const label = (n ? `${pad(n)} ` : '') + plain(title)
  return (
    <h2
      id={id}
      aria-label={label}
      className={`todo-heading ${note ? NOTE_MARK : BOX_BEFORE}`} // src/styles/components/docs.css
    >
      {n ? (
        <>
          <span className="gx-n relative -top-[.39em] mr-[.6em] inline-block min-w-[1.6em] flex-none align-[.22em] text-[.56em] leading-none tracking-normal text-eyebrow tabular-nums">{pad(n)}</span>{' '}
        </>
      ) : null}
      <Html className="min-w-0" html={title} />
      <HeadingAnchor id={id} label={label} />
    </h2>
  )
}
/**
 * The rail entry for a to-do heading (its markup minus the permalink). The number is a quiet
 * tabular index; Rail.tsx hangs a wrapped title under itself (`a:has(> .gx-n)`).
 */
const todoRail = (id: string, title: string, n?: number): RailItem => ({
  id,
  html: (n ? `<span class="gx-n inline-block min-w-[22px] indent-0 text-11.5 leading-none tracking-normal text-quiet tabular-nums">${pad(n)}</span> ` : '') + `<span>${title}</span>`,
  depth: 2,
})

/** A to-do row: a hairline above, the heading's box in the left gutter. Kills the docs' list numbers and dashes. */
const TODO_ITEM = 'relative m-0 mt-12 border-t border-hairline pt-[30px] pr-0 pb-0 pl-[34px] before:content-none [&::marker]:content-none max-md:mt-10 max-md:pt-[26px] max-md:pl-[30px]'

/** One to-do: the screen-reader "To do" (the box is on its heading), its heading, then its parts. With `note`, "Note". */
function Todo({ note, heading, children }: { note?: boolean; heading: ReactNode; children: ReactNode }) {
  return (
    <li className={note ? `rm-note ${TODO_ITEM}` : TODO_ITEM}>
      <span className="sr-only" data-pagefind-ignore="">
        {note ? 'Note' : 'To do'}
      </span>
      {heading}
      {children}
    </li>
  )
}
/** The to-do lists: the rows draw their own rules and boxes. */
const TODO_LIST = 'm-0 max-w-none list-none border-0 p-0'

/** The paragraph right under a to-do's heading. */
const META = 'mt-0 mb-3 flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-13 leading-5 text-muted-fg'

/**
 * Today / Plan (and link rows) as a description list. The Today row sits on the plain surface and
 * the rows after it on a neutral fill; link-run rows (any label but Today and Plan) mark their dd.
 * No overflow clipping, so focus rings on the links inside stay whole; the rows round their own corners.
 */
function Detail({ rows }: { rows: [label: string, body: string | ReactNode][] }) {
  return (
    <dl className={`gx-wf mt-[18px] rounded-box border border-border bg-muted print:break-inside-avoid ${PRINT_EXACT}`}>
      {rows.map(([lab, body], i) => {
        const run = lab !== 'Today' && lab !== 'Plan'
        const afterToday = i > 0 && rows[i - 1][0] === 'Today'
        // Search leaves out the labels and the link runs after the Plan (as the old index did).
        const skip = i > 0 && !afterToday
        const cls = [
          'grid grid-cols-[minmax(0,1fr)] gap-1 px-[18px] pb-4 first:rounded-t-[13px] last:rounded-b-[13px] @min-rm-sm:grid-cols-[124px_minmax(0,1fr)] @min-rm-sm:gap-x-5 @min-rm-sm:px-5',
          PRINT_EXACT,
          lab === 'Today' ? 'bg-surface' : '',
          afterToday ? 'border-t border-hairline' : '',
          skip ? 'pt-0' : 'pt-4',
        ].join(' ')
        const dd = [DD, run ? RUN : ''].join(' ')
        return (
          <div key={lab} className={cls} data-pagefind-ignore={skip ? '' : undefined}>
            <dt className={`m-0 ${LABEL} @min-rm-sm:leading-[25px]`} data-pagefind-ignore="">
              {lab}
            </dt>
            {typeof body === 'string' ? <Html as="dd" className={dd} html={body} /> : <dd className={dd}>{body}</dd>}
          </div>
        )
      })}
    </dl>
  )
}

/** A detail's body: HTML from the data (paragraphs, lists) at the detail's own size. */
const DD = 'm-0 text-15 leading-[1.65] text-fg-body [&_li]:text-[length:inherit] [&_li]:leading-[inherit] [&>*+*]:mt-2.5 [&>:is(p,ul)]:m-0 [&>:is(p,ul)]:max-w-none [&>:is(p,ul)]:text-[length:inherit] [&>:is(p,ul)]:leading-[inherit]'

/** Feature chips: links to the features' rows, named from the data, with the status for screen readers. */
function Chips({ rm, ids }: { rm: Roadmap; ids: string[] }) {
  return (
    <div
      className="gx-chips not-prose mt-4 flex flex-wrap items-center gap-1.5 empty:hidden before:mr-1.5 before:text-12 before:leading-4.5 before:tracking-label before:text-eyebrow before:uppercase before:content-['Features']"
      data-pagefind-ignore=""
    >
      {ids.map((id) => {
        const f = rm.FEATS[id]
        const v = VC[f.status]
        return (
          <a
            key={id}
            href={rm.hrefOf(`roadmap-f-${id}`)}
            data-v={v}
            className={`feature-chip ${DOT} before:bg-[var(--vc,var(--faint))]`}
          >
            <span className="sr-only">{rm.VLABEL(f.status)}: </span>
            {f.name}
          </a>
        )
      })}
    </div>
  )
}

const SITES_LABEL = "before:mr-2 before:text-12 before:tracking-label before:text-eyebrow before:uppercase before:content-['Sites']"
/** The sites a to-do or feature concerns ("Sites" label before them in a to-do's meta line). */
function SiteTags({ rm, repos, label }: { rm: Roadmap; repos: string[]; label?: boolean }) {
  return repos.length ? (
    <span className={label ? `text-muted-fg ${SITES_LABEL}` : 'text-muted-fg'}>
      {repos.map((r) => rm.SHORT[r]).join(' · ')}
    </span>
  ) : null
}

/** A link to a to-do, named by its title. */
const ItemLink = ({ rm, id, className }: { rm: Roadmap; id: string; className?: string }) => <Html as="a" href={rm.hrefOf(id)} className={className} html={rm.title(id)} />

/** A link to a work item or, with the site and step number, to a site step. */
function RefLink({ rm, id }: { rm: Roadmap; id: string }) {
  const s = rm.STEP.get(id)
  if (!s) return <ItemLink rm={rm} id={id} />
  return (
    <span>
      <ItemLink rm={rm} id={id} />{' '}
      <span className="text-13.5 text-muted-fg">
        ({rm.SHORT[s.site]} step {s.n})
      </span>
    </span>
  )
}

/** A status label with its marker ("<b>11</b> to build", "Done"). */
const LG = `inline-flex items-center gap-1.5 whitespace-nowrap ${DOT}`

/** Counts by status, as "<b>11</b> to build" markers. */
function Legend({ rm, ids }: { rm: Roadmap; ids: string[] }) {
  return (
    <>
      {rm
        .counts(ids)
        .filter(([, n]) => n)
        .map(([v, n]) => (
          <span key={v} className={LG} data-v={VC[v]}>
            <b className="font-medium text-fg tabular-nums">{n}</b> {rm.vword(v, n)}
          </span>
        ))}
    </>
  )
}

function OpenWork({ rm, ids }: { rm: Roadmap; ids: string[] }) {
  const eff: Record<string, number> = { L: 0, M: 0, S: 0 }
  for (const i of ids) if (OPEN.has(rm.FEATS[i].status)) eff[rm.FEATS[i].effort]++
  return (
    <>
      Open work: <b>{eff.L}</b> L · <b>{eff.M}</b> M · <b>{eff.S}</b> S
    </>
  )
}

/**
 * One status bar (all sites, or one site), with its legend and effort tally. From 640px of column
 * the label sits in its own column left of the bar, legend and description.
 */
function BarRow({ rm, label, labelText, ids, descHtml, big }: { rm: Roadmap; label: ReactNode; labelText: string; ids: string[]; descHtml?: string; big?: boolean }) {
  const cs = rm.counts(ids).filter(([, n]) => n)
  const aria = cs.map(([v, n]) => `${n} ${rm.vword(v, n)}`).join(', ')
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-y-2 print:break-inside-avoid @min-rm:grid-cols-[200px_minmax(0,1fr)] @min-rm:gap-x-6">
      <p
        className="m-0 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-14 leading-5 text-fg @min-rm:col-1 @min-rm:row-span-3 @min-rm:row-start-1 @min-rm:flex-col @min-rm:justify-start @min-rm:self-start [&_b]:font-medium"
        data-pagefind-ignore=""
      >
        {label}
        <span className="text-12.5 text-muted-fg">{ids.length} features</span>
      </p>
      <div
        className={`flex ${big ? 'h-4' : 'h-3'} gap-0.5 overflow-hidden rounded-full bg-gx-track @min-rm:col-2 @min-rm:row-1 @min-rm:mt-1 @min-rm:self-center`}
        role="img"
        aria-label={`${labelText}: ${aria}`}
        data-pagefind-ignore=""
      >
        {cs.map(([v, n]) => (
          <i key={v} data-v={VC[v]} className={`min-w-1 bg-(--vc) ${vvars(VC[v])} ${PRINT_EXACT}`} style={{ flex: `${n} 0 0` }} />
        ))}
      </div>
      <p className="m-0 flex flex-wrap items-center gap-x-4 gap-y-1 text-12.5 leading-5 text-muted-fg @min-rm:col-2 @min-rm:row-2" data-pagefind-ignore="">
        <Legend rm={rm} ids={ids} />
        <span className="ml-auto [&_b]:font-medium [&_b]:text-fg-body" title="Effort of the features to build, to finish and left to site code">
          <OpenWork rm={rm} ids={ids} />
        </span>
      </p>
      {descHtml ? (
        <Html
          as="p"
          className="mx-0 mt-0.5 mb-0 max-w-none text-14 leading-[1.6] text-fg-body @min-rm:col-2 @min-rm:row-3 [&_code]:text-12.5 [&>span]:text-muted-fg"
          html={descHtml}
        />
      ) : null}
    </div>
  )
}

/** A status pill. */
const Pill = ({ rm, v, className = '' }: { rm: Roadmap; v: string; className?: string }) => (
  <b
    className={`gx-vp ${DOT} ${PRINT_EXACT} ${className}`} // gx-vp: src/styles/components/docs.css
    data-v={VC[v]}
  >
    {rm.VLABEL(v)}
  </b>
)

/** A site step's kind pill: Fix now, Before migrating, Blocker, Site work, Content, Note. */
const KIND_CLS: Record<string, string> = {
  now: 'bg-gx-now-bg text-gx-now-fg',
  pre: 'bg-gx-a-bg text-gx-a-fg',
  blocker: 'bg-gx-g-bg text-gx-g-fg',
  content: 'bg-gx-p-bg text-gx-p-fg',
  fix: 'bg-transparent text-muted-fg inset-ring inset-ring-border-strong',
}
const Kind = ({ k, className = '' }: { k: keyof typeof KIND; className?: string }) => (
  <span
    className={`gx-kind inline-flex h-[22px] items-center rounded-full px-2.5 text-12 leading-4 font-medium tracking-[.01em] whitespace-nowrap ${KIND_CLS[k] ?? 'bg-muted text-fg-body'} ${PRINT_EXACT} ${className}`}
    data-k={k}
  >
    {KIND[k]}
  </span>
)

/** The status key for chip dots (the to-build marker is a diamond, so it doesn't rely on colour). */
function Key({ rm }: { rm: Roadmap }) {
  return (
    <span className="ml-1 inline-flex flex-wrap gap-x-3.5 gap-y-0.5 text-13.5">
      {rm.VERDICTS.filter((v) => rm.TOTALS[v]).map((v) => (
        <span key={v} className={LG} data-v={VC[v]}>
          {rm.vword(v, 1)}
        </span>
      ))}
    </span>
  )
}

/**
 * The inline "On this page" outline, placed after the lede. Provided by RoadmapPage (it needs the
 * docs shell's context); empty when a section is rendered on its own (scripts/check-roadmap.ts).
 */
export const TocSlot = createContext<ReactNode>(null)

/**
 * The section's article: eyebrow (with its count), h1, lede, the inline outline, then the body.
 * `gx-sec` is the query container (the tiles, bars, detail lists and feature rows reflow on the
 * column's width, not the window's) and RoadmapPage's hook for links inside the article.
 */
function Article({ rm, id, count, lede, children }: { rm: Roadmap; id: SectionId; count?: string; lede: ReactNode; children: ReactNode }) {
  const s = rm.SEC[id]
  return (
    <article id={id} className="doc-section doc-page gx-sec @container" aria-labelledby={`${id}-title`} data-pagefind-body="">
      <p className="eyebrow eyebrow-label mt-0 mb-3.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 leading-4.5">
        {s.eyebrow}
        {count ? (
          <span
            className="rm-count inline-flex h-[22px] items-center gap-[7px] rounded-full pr-2.5 pl-2 text-12 leading-4 tracking-[.01em] whitespace-nowrap normal-case text-muted-fg tabular-nums inset-ring inset-ring-border-strong before:box-border before:size-2.5 before:flex-none before:rounded-[3px] before:border-[1.25px] before:border-quiet before:bg-surface"
            data-pagefind-ignore=""
          >
            {count}
          </span>
        ) : null}
      </p>
      <Html as={'h1' as 'span'} id={`${id}-title`} tabIndex={-1} html={s.title} />
      {lede}
      {useContext(TocSlot)}
      {children}
    </article>
  )
}

export interface SectionView {
  article: ReactNode
  rail: RailItem[]
}
const OVERVIEW: RailItem = { id: null, html: 'Overview', depth: 1 }

const blockerLede = (rm: Roadmap) =>
  "Ranked by how much each one blocks, in the reviewers' judgment, so the order doesn't follow the feature count shown beside each." +
  (rm.allSitesBlockers ? ' Every one hits all three sites.' : '')

// ------------------------------------------------------------------------------ 1 · overview
export function overview(rm: Roadmap): SectionView {
  const n = rm.FIDS.length
  const T = rm.TOTALS
  const F = Object.values(rm.FEATS)
  // The intro is a run of <p>s; the first is the lede, and the inline outline goes after it.
  const [ledeHtml, ...restHtml] = rm.introParagraphs
  const shorts = rm.REPOS.map((r) => <b key={r}>{rm.SHORT[r]}</b>)
  const nStudio = rm.STUDIO_NEW.length + rm.STUDIO_LEGACY.length
  const nLater = rm.WORK_BY_GROUP.later.length
  const nRelease = rm.CHANGES.length - nLater
  const head = (id: string, text: string): RailItem => ({ id, html: esc(text), depth: 2 })
  const article = (
    <Article rm={rm} id="roadmap" lede={<Html as="p" html={ledeHtml} />}>
      {restHtml.map((h, i) => (
        <Html key={i} as="p" html={h} />
      ))}
      {rm.OV.fix_now ? (
        <div className={`${TODO_CALLOUT} border-border bg-bg-subtle`}>
          <p className={TODO_CALLOUT_P}>
            <span className="sr-only" data-pagefind-ignore="">
              To do:{' '}
            </span>
            <Kind k="now" className="mr-2 align-[1px]" />
            <Html html={rm.OV.fix_now} />
          </p>
        </div>
      ) : null}
      <SubHeading id="roadmap--the-ten-release-blockers">The ten release blockers</SubHeading>
      <p>{blockerLede(rm)} Each links to where it stands today, the plan and the work items that deliver it.</p>
      {/* The docs' numbered hairline rows, each with its to-do box before the number. */}
      <ol className="my-[18px] list-none border-b border-hairline p-0">
        {rm.TOP.map((g, i) => (
          <li
            key={g.id}
            data-n={pad(i + 1)}
            className={`relative m-0 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-hairline py-3.5 pr-0 pl-[78px] before:absolute before:top-4 before:left-9 before:text-13 before:leading-6 before:text-ol-num before:tabular-nums before:content-[attr(data-n)] ${BOX_AFTER} after:absolute after:top-[19px] after:left-0.5`}
          >
            <span className="sr-only" data-pagefind-ignore="">
              To do:{' '}
            </span>
            <ItemLink rm={rm} id={g.id} className="font-medium" />
            <span className="flex-none text-12.5 leading-5 text-muted-fg tabular-nums" data-pagefind-ignore="">
              {g.features.length} features
            </span>
          </li>
        ))}
      </ol>
      <SubHeading id="roadmap--release-readiness">Release readiness</SubHeading>
      <Html as="p" html={rm.OV.readiness_lead} />
      {/* The verdict tiles: the legend and the totals in one. */}
      <ul
        className="not-prose mx-0 mt-6 mb-2 grid max-w-none list-none grid-cols-[minmax(0,1fr)] gap-px overflow-hidden rounded-2xl border border-border bg-border p-0 print:break-inside-avoid @min-rm:grid-cols-[repeat(5,minmax(0,1fr))]"
        aria-label="Features by status"
      >
        {rm.VERDICTS.map((v) => (
          <li
            key={v}
            className="m-0 grid grid-cols-[64px_minmax(0,1fr)] items-center gap-x-3 bg-bg px-[18px] py-3.5 @min-rm:flex @min-rm:flex-col @min-rm:items-start @min-rm:gap-3.5 @min-rm:px-4 @min-rm:py-5"
          >
            <span className={`text-34 leading-none font-light tracking-[-.03em] tabular-nums @min-rm:text-44 ${v === 'done' ? 'text-quiet' : 'text-fg'}`}>{T[v]}</span>
            <Pill rm={rm} v={v} className="justify-self-start" />
            <span className="col-2 mt-1.5 text-13 leading-4.5 text-muted-fg @min-rm:-mt-1">{rm.status(v).tile}</span>
          </li>
        ))}
      </ul>
      <div className="mt-7 mb-8 grid gap-5">
        <BarRow rm={rm} big label={<b>All three sites</b>} labelText="All three sites" ids={rm.FIDS} />
        {rm.REPOS.map((r) => (
          <BarRow
            key={r}
            rm={rm}
            label={
              <a href={rm.hrefOf(rm.SITE_SEC[r])}>
                <b>{rm.NAME[r]}</b>
              </a>
            }
            labelText={rm.NAME[r]}
            ids={rm.REPO_IDS[r]}
            descHtml={`<span>${rm.REPO_DESC[r]}</span> ${rm.HEADLINE[r]}`}
          />
        ))}
      </div>
      <p className="mt-5 mb-3 text-14 leading-5.5 text-muted-fg">
        Each bar counts the features in its scope: all three sites, then each site. Open work counts the features still to build, finish or leave to site code, by relative effort: S, M or L. Short
        names on this page: {join(shorts.slice(0, -1), ', ')} and {shorts[shorts.length - 1]}.
      </p>
      <div className={`${TODO_CALLOUT} border-warn-border bg-warn-bg`}>
        <Html
          as="p"
          className={`${TODO_CALLOUT_P} [&_.rm-do-t]:mb-1 [&_.rm-do-t]:block [&_.rm-do-t]:w-fit`}
          html={`<span class="sr-only" data-pagefind-ignore="">To do: </span>${rm.OV.fix_docs}`}
        />
      </div>
      <SubHeading id="roadmap--using-this-page">Using this page</SubHeading>
      <ul>
        <li>
          <a href={rm.hrefOf('roadmap-blockers')}>Release blockers</a>: the ten items that gate the release, each with where it stands today, the plan and the work items that deliver it.
        </li>
        <li>
          <a href={rm.hrefOf('roadmap-studio-new')}>Studio support</a>: what has to work for editors, on a next-major site and with legacy content ({nStudio} items).
        </li>
        <li>
          <a href={rm.hrefOf('roadmap-api')}>Work items</a>: {nRelease} changes, deduplicated from the {n} per-feature proposals, in four groups: the API, the CLI, Studio and the Deco
          API, and these docs.
        </li>
        <li>
          <a href={rm.hrefOf('roadmap-later')}>After the first release</a>: {nLater} follow-up{nLater === 1 ? '' : 's'} planned once the first release ships. They don't block it.
        </li>
        <li>
          <a href={rm.hrefOf('roadmap-storefront')}>Site migrations</a>: each site's plan as a checklist, in execution order ({rm.nSteps} steps).
        </li>
        <li>
          <a href={rm.hrefOf('roadmap-features')}>Feature readiness</a>: every feature with its status, effort, sites and a short summary, the parts of these docs it concerns, and the roadmap
          items that address it. Feature chips anywhere on this page link there.
        </li>
      </ul>
      <p>
        The lists overlap, so their counts don't add up to one total: the release blockers and most Studio items are delivered by work items, and link to them, and several site steps depend on the
        same work. Nothing is checked off yet; the boxes mark open items and don't track progress.
      </p>
      <Small>
        How this list was made: each site's features were catalogued from its code, with file and line evidence, and grouped into {rm.CATS.length} categories. Each feature was then assessed against
        these docs, and a second reviewer checked each assessment against Studio's and the framework's code. That check changed {F.filter((f) => f.first_rated).length} statuses, all to “to finish”,
        and a later review changed {F.filter((f) => f.rated_before_review).length} more. {F.filter((f) => f.confidence !== 'high').length} of the {n} assessments are medium confidence and the rest
        are high, and {F.filter((f) => f.unconfirmed_sub_claim).length} contain a sub-claim the second reviewer couldn't confirm. Feature readiness marks each of these on its row.
      </Small>
    </Article>
  )
  return {
    article,
    rail: [OVERVIEW, head('roadmap--the-ten-release-blockers', 'The ten release blockers'), head('roadmap--release-readiness', 'Release readiness'), head('roadmap--using-this-page', 'Using this page')],
  }
}

// ------------------------------------------------------------------------------ 2 · release blockers
export function blockers(rm: Roadmap): SectionView {
  const article = (
    <Article
      rm={rm}
      id="roadmap-blockers"
      count={`${rm.TOP.length} to do`}
      lede={<p>{blockerLede(rm)} Each says where things stand today, the plan, and the work items that deliver it; the chips link to the affected features.</p>}
    >
      <ol className={TODO_LIST}>
        {rm.TOP.map((g, i) => {
          const h = rm.html.blocker.get(g.id)!
          return (
            <Todo key={g.id} heading={<TodoHeading id={g.id} title={g.title} n={i + 1} />}>
              {rm.allSitesBlockers ? null : (
                <p className={META} data-pagefind-ignore="">
                  <SiteTags rm={rm} repos={rm.sitesOf(g.features)} label />
                </p>
              )}
              <Detail
                rows={[
                  ['Today', h.today],
                  ['Plan', h.plan],
                  [
                    'Delivered by',
                    <>
                      {join(g.delivered_by.map((k) => <ItemLink rm={rm} id={k} />))}
                      {h.note ? (
                        <>
                          {' '}
                          <Html className="mt-1 block text-14 text-muted-fg" html={h.note} />
                        </>
                      ) : null}
                    </>,
                  ],
                ]}
              />
              <Chips rm={rm} ids={g.features} />
            </Todo>
          )
        })}
      </ol>
    </Article>
  )
  return { article, rail: [OVERVIEW, ...rm.TOP.map((g, i) => todoRail(g.id, g.title, i + 1))] }
}

// ------------------------------------------------------------------------------ 3 · studio support
const STUDIO_LEDE = {
  'roadmap-studio-new':
    "What has to work when a migrated site runs against today's Studio. Each item says what happens today and, where a work item's plan covers it, which work items deliver it. The chips link to the features it touches.",
  'roadmap-studio-legacy':
    'Content and assumptions Studio already has, which the next major has to handle. Each item says what happens today and, where the plan covers it, which work items or site steps handle it.',
} as const

export function studio(rm: Roadmap, id: 'roadmap-studio-new' | 'roadmap-studio-legacy'): SectionView {
  // Unnumbered: unlike the blockers and the site plans, the order isn't a ranking.
  const items = id === 'roadmap-studio-new' ? rm.STUDIO_NEW : rm.STUDIO_LEGACY
  const article = (
    <Article rm={rm} id={id} count={`${items.length} to do`} lede={<p>{STUDIO_LEDE[id]}</p>}>
      <ul className={TODO_LIST}>
        {items.map((x) => (
          <Todo key={x.id} heading={<TodoHeading id={x.id} title={x.title} />}>
            <Detail
              rows={[
                ['Today', rm.html.studio.get(x.id)!.today],
                ...(x.delivered_by.length ? [['Delivered by', <>{join(x.delivered_by.map((r) => <RefLink rm={rm} id={r} />))}</>] as [string, ReactNode]] : []),
              ]}
            />
            <Chips rm={rm} ids={x.features} />
          </Todo>
        ))}
      </ul>
    </Article>
  )
  return { article, rail: [OVERVIEW, ...items.map((x) => todoRail(x.id, x.title))] }
}

// ------------------------------------------------------------------------------ 4 · work items
export function changes(rm: Roadmap, key: WorkGroup): SectionView {
  const id = GROUP_SEC[key]
  const items = rm.WORK_BY_GROUP[key]
  const sort = "They're sorted by how many features need them."
  const lede = {
    api: (
      <>
        {items.length} changes to the SDK, the bindings and the <code className="is-short">@decocms/apps-*</code> packages. {sort}
      </>
    ),
    cli: (
      <>
        {items.length} changes to the <code className="is-short">deco</code> CLI's output, codegen and migration tooling. {sort}
      </>
    ),
    studio: (
      <>
        {items.length} changes on the Studio side and in the Deco API's release service. {sort}
      </>
    ),
    docs: (
      <>
        {items.length} changes to the guides, recipes and reference. Two of them correct statements that are wrong today; they come first, and the rest are sorted by how many features need them.
      </>
    ),
    later: (
      <>
        {items.length} follow-up{items.length === 1 ? '' : 's'} planned after the first release. None of them blocks the release, and their APIs aren't designed yet. {sort}
      </>
    ),
  }[key]
  const article = (
    <Article
      rm={rm}
      id={id}
      count={`${items.length} to do`}
      lede={
        <p>
          {lede} A chip's dot shows that feature's status: <Key rm={rm} />.
        </p>
      }
    >
      <ul className={TODO_LIST}>
        {items.map((c) => {
          const ids = c.features
          // How many of the item's features have the status To build, said as part of the feature
          // count, so it doesn't read as the item's own status or as a count of sub-tasks.
          const nBuild = ids.filter((x) => rm.FEATS[x].status === 'to-build').length
          let nf = `${ids.length} feature${ids.length !== 1 ? 's' : ''}`
          if (nBuild) nf += nBuild === ids.length && ids.length === 1 ? ', to build' : `, ${nBuild} of them to build`
          const rows: [string, string | ReactNode][] = [['Plan', rm.html.work.get(c.id)!.plan]]
          if (c.docs.length) rows.push(['In these docs', <>{join(c.docs.map((x) => <a href={rm.hrefOf(x)}>{rm.docLabel(x)}</a>))}</>])
          const cl = rm.CLEARS.get(c.id)
          // One part of the blocker, not all of it: most blockers need two to four work items.
          if (cl) rows.push([`Part of blocker${cl.length > 1 ? 's' : ''}`, <>{join(cl.map((i) => <ItemLink rm={rm} id={rm.TOP[i - 1].id} />))}</>])
          return (
            <Todo key={c.id} heading={<TodoHeading id={c.id} title={c.title} />}>
              <p className={META} data-pagefind-ignore="">
                <span className="text-fg-body">{nf}</span>
                <SiteTags rm={rm} repos={rm.sitesOf(ids)} label />
              </p>
              <Detail rows={rows} />
              <Chips rm={rm} ids={ids} />
            </Todo>
          )
        })}
      </ul>
    </Article>
  )
  return { article, rail: [OVERVIEW, ...items.map((c) => todoRail(c.id, c.title))] }
}

// ------------------------------------------------------------------------------ 5 · site migrations
export function sitePlan(rm: Roadmap, r: string): SectionView {
  const id = rm.SITE_SEC[r]
  const ids = rm.REPO_IDS[r]
  const steps = rm.PLAN[r]
  const nNote = steps.filter((s) => s.no_action).length
  const count = `${steps.length - nNote} to do` + (nNote ? ` · ${nNote} note` : '')
  const article = (
    <Article rm={rm} id={id} count={count} lede={<Html as="p" html={rm.HEADLINE[r]} />}>
      <Html
        as="p"
        className="mt-0 mb-2 text-15 leading-[1.6] text-muted-fg"
        html={`<span class="mr-2.5 text-12 leading-4.5 font-normal tracking-label uppercase text-eyebrow" data-pagefind-ignore="">The site</span>${rm.REPO_DESC[r]}`}
      />
      <div className="mt-7 mb-8 grid gap-5">
        <BarRow rm={rm} big label={<b>{rm.NAME[r]}</b>} labelText={rm.NAME[r]} ids={ids} />
      </div>
      <p>
        The steps are in execution order, each tagged: <b>Fix now</b> (a live bug, migration or not), <b>Before migrating</b> (an upgrade that comes first), <b>Blocker</b> (must be solved before this
        site can move; separate from the ten release blockers), <b>Site work</b>, <b>Content</b> (stored content and data shapes), and <b>Note</b>.{nNote ? ' A note with nothing to do has no box.' : ''}{' '}
        <a href={rm.hrefOf('roadmap-features')} data-gx-site={rm.SHORT[r]}>
          See where the {ids.length} features it uses stand
        </a>
        .
      </p>
      <ol className={TODO_LIST}>
        {steps.map((s, i) => (
          <Todo key={s.id} note={s.no_action} heading={<TodoHeading id={s.id} title={s.title} n={i + 1} note={s.no_action} />}>
            <p className={META} data-pagefind-ignore="">
              <Kind k={s.kind} />
            </p>
            <Html as="p" className="mt-0" html={rm.html.step.get(s.id)!.text} />
            <Chips rm={rm} ids={s.features} />
          </Todo>
        ))}
      </ol>
    </Article>
  )
  return { article, rail: [OVERVIEW, ...steps.map((s, i) => todoRail(s.id, s.title, i + 1))] }
}

// ------------------------------------------------------------------------------ 6 · feature readiness
/** The status/site filter of the feature list: `v` a status code ("g"…), `s` a site short name. */
export interface FeatureFilter {
  v: string
  s: string
}
export const NO_FILTER: FeatureFilter = { v: '', s: '' }

export function featureHit(rm: Roadmap, fid: string, k: 'v' | 's', val: string): boolean {
  if (!val) return true
  const f = rm.FEATS[fid]
  return k === 'v' ? VC[f.status] === val : f.sites.some((r) => rm.SHORT[r] === val)
}
const shown = (rm: Roadmap, fid: string, f: FeatureFilter) => featureHit(rm, fid, 'v', f.v) && featureHit(rm, fid, 's', f.s)

/** The categories' headings that the filter leaves visible, for the rail. */
export function featureRail(rm: Roadmap, filter: FeatureFilter): RailItem[] {
  return [
    OVERVIEW,
    ...rm.CATS.filter((c) => rm.featuresIn(c.id).some((fid) => shown(rm, fid, filter))).map((c) => ({ id: `roadmap-features--${slug(c.title)}`, html: esc(c.title), depth: 2 as const })),
  ]
}

/** A feature row's assessment tag (Medium confidence, First rated …). */
const TAG = 'gx-tg inline-flex h-5 items-center rounded-full px-2 text-11.5 leading-4 whitespace-nowrap text-muted-fg not-italic inset-ring inset-ring-border-strong'

function RowTags({ rm, fid }: { rm: Roadmap; fid: string }) {
  // The earlier statuses are ratings the assessment gave and later corrected, not progress that
  // was undone, so the tags name the rating ("First rated …") rather than a past state ("Was …").
  const f = rm.FEATS[fid]
  return (
    <>
      {f.confidence !== 'high' ? <i className={TAG}>Medium confidence</i> : null}
      {f.first_rated ? (
        <i className={TAG} title="The assessor's first rating; verification against the code changed it">
          First rated {rm.vq(f.first_rated)}
        </i>
      ) : null}
      {f.rated_before_review ? (
        <i className={TAG} title="The status a later review changed">
          Rated {rm.vq(f.rated_before_review)} before review
        </i>
      ) : null}
      {f.unconfirmed_sub_claim ? (
        <i className={TAG} title="Contains a sub-claim the verifier couldn't confirm">
          Unconfirmed sub-claim
        </i>
      ) : null}
    </>
  )
}

/** The filter's groups and their labels. */
const FG = 'flex flex-wrap items-center gap-1.5'
const FL = `mr-1 min-w-14 ${LABEL}`
/** A feature row's link runs: where these docs cover it, and what addresses it; the labels are CSS so each row stays small. */
const FX_RUN = `mb-0 max-w-none text-13 leading-[21px] text-muted-fg before:mr-2.5 before:text-11.5 before:tracking-label before:text-eyebrow before:uppercase ${RUN}`
/** Inline padding: a 24px target (WCAG 2.5.8) without moving the lines. */
const RUN_LINK = 'py-1 text-13'

export function features(rm: Roadmap, filter: FeatureFilter = NO_FILTER, setFilter?: (f: FeatureFilter) => void): SectionView {
  const T = rm.TOTALS
  const all = rm.FIDS
  const nShown = all.filter((fid) => shown(rm, fid, filter)).length
  const countText = nShown === all.length ? `Showing all ${nShown} features` : nShown ? `Showing ${nShown} of ${all.length} features` : 'No feature matches both filters'
  /** A filter button: pressed state, and the rows it would show given the other filter. */
  const btn = (k: 'v' | 's', val: string, children: ReactNode, extra?: { title?: string; count?: boolean }) => {
    const other = k === 'v' ? 's' : 'v'
    const n = all.filter((fid) => featureHit(rm, fid, k, val) && featureHit(rm, fid, other, filter[other])).length
    return (
      <button
        key={val || 'all'}
        type="button"
        className="inline-flex h-8 cursor-pointer items-center gap-[7px] rounded-full border border-border bg-surface px-[13px] text-13 leading-4.5 text-muted-fg [transition:color_.25s_ease,border-color_.25s_ease,background-color_.25s_ease,scale_.25s_var(--ease-out-quart)] hover:border-border-strong hover:text-fg active:scale-[.97] aria-pressed:border-transparent aria-pressed:bg-fg aria-pressed:text-bg max-sm:h-[30px] max-sm:px-[11px]"
        data-fk={k}
        data-fv={val}
        aria-pressed={filter[k] === val}
        title={extra?.title}
        onClick={() => setFilter?.({ ...filter, [k]: val })}
      >
        {children}
        {extra?.count === false ? null : (
          <>
            {' '}
            <span className="text-quiet tabular-nums in-aria-pressed:text-inherit in-aria-pressed:opacity-80">{n}</span>
          </>
        )}
      </button>
    )
  }
  const done = T.done
  const gone = T['goes-away']
  const article = (
    <Article
      rm={rm}
      id="roadmap-features"
      count={`${done} of ${all.length - gone} done · ${gone} go away`}
      lede={
        <p>
          All {all.length} features the three sites use, grouped into {rm.CATS.length} categories, and where each one stands. Within a category, features to build come first, then those to finish,
          left to site code and going away, each ordered by effort (L, M, S). Each row names the parts of these docs the feature concerns and, below that, the release blockers and work items that
          address it. Feature chips elsewhere on this page link to these rows.
        </p>
      }
    >
      {/* The status legend: one status per line, label (with its marker) then meaning. */}
      <dl className="mt-5 mb-0 grid gap-1 text-14 leading-5.5 @max-[460px]:gap-2" aria-label="Statuses">
        {rm.VERDICTS.map((v) => (
          <div key={v} className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 @max-[460px]:grid-cols-[minmax(0,1fr)]">
            <dt className="m-0">
              <b className={`${LG} font-medium text-fg`} data-v={VC[v]}>
                {rm.VLABEL(v)}
              </b>
            </dt>
            <Html as="dd" className="m-0 text-muted-fg" html={rm.status(v).legend} />
          </div>
        ))}
      </dl>
      {/* Without JavaScript the filter does nothing, so it's hidden unless <html> has the `js` class
          (set by the inline head script before first paint, so it never shifts the list). */}
      <div className="not-prose mt-7 mb-2 flex flex-col gap-2.5 rounded-2xl border border-border bg-bg-subtle p-3.5 no-js:hidden max-sm:p-3 print:hidden" data-pagefind-ignore="">
        <div className={FG} role="group" aria-label="Filter by status">
          <span className={FL}>Status</span>
          {btn('v', '', 'All statuses', { count: false })}
          {rm.VERDICTS.filter((v) => T[v]).map((v) =>
            btn(
              'v',
              VC[v],
              <>
                <i data-v={VC[v]} className={`size-[7px] flex-none rounded-full bg-(--vc) data-[v=g]:rounded-[1px] data-[v=g]:[transform:rotate(45deg)_scale(.9)] ${vvars(VC[v])}`} />
                {rm.VLABEL(v)}
              </>,
            ),
          )}
        </div>
        <div className={`${FG} border-t border-hairline pt-2.5`} role="group" aria-label="Filter by site">
          <span className={FL}>Site</span>
          {btn('s', '', 'All sites', { count: false })}
          {rm.REPOS.map((r) => btn('s', rm.SHORT[r], rm.SHORT[r], { title: rm.NAME[r] }))}
        </div>
        <p className="m-0 text-13 leading-5 text-muted-fg" aria-live="polite">
          {countText}
        </p>
      </div>
      {rm.CATS.map((cat) => {
        const ids = rm.featuresIn(cat.id)
        // A category with no matching rows hides whole: heading, description and list.
        const off = !ids.some((fid) => shown(rm, fid, filter))
        const hid = `roadmap-features--${slug(cat.title)}`
        return (
          <Fragment key={cat.id}>
            <SubHeading id={hid} className="mt-14 text-25 max-sm:mt-11 max-sm:text-22" hidden={off}>
              {cat.title}
            </SubHeading>
            <p className="mt-0 mb-4 text-14 leading-5.5 text-muted-fg" hidden={off}>
              {ids.length} feature{ids.length !== 1 ? 's' : ''} · {cat.description}
              <span className="mt-1.5 flex flex-wrap gap-x-3.5 gap-y-0.5 text-12.5" data-pagefind-ignore="">
                <Legend rm={rm} ids={ids} />
              </span>
            </p>
            {/* Rows bleed evenly into the margin, so their text lines up with the column. */}
            <ul className="-mx-3 my-0 max-w-none list-none border-t border-hairline p-0 max-sm:-mx-2" hidden={off}>
              {ids.map((fid) => {
                const f = rm.feature(fid)
                const back = rm.BACK.get(fid)
                return (
                  <li
                    key={fid}
                    id={`roadmap-f-${fid}`}
                    data-v={f.v}
                    hidden={!shown(rm, fid, filter)}
                    className="feature-row"
                  >
                    <h3 className="m-0 text-16 leading-[23px] font-medium tracking-snug text-wrap text-fg @min-rm:col-1 @min-rm:row-1">{f.name}</h3>
                    <p
                      className="m-0 flex max-w-none flex-wrap items-center gap-x-3 gap-y-1 text-12.5 leading-5 text-muted-fg @min-rm:col-1 @min-rm:row-2 @min-rm:self-start"
                      data-pagefind-ignore=""
                    >
                      <Pill rm={rm} v={f.status} />
                      <span>Effort {f.effort}</span>
                      <SiteTags rm={rm} repos={f.sites} />
                      <RowTags rm={rm} fid={fid} />
                    </p>
                    <div className="@min-rm:col-2 @min-rm:row-span-2 @min-rm:row-start-1 @min-rm:self-start">
                      <Html as="p" className="m-0 max-w-none text-15 leading-[1.62] text-fg-body [&_code]:text-12.5" html={f.summaryHtml} />
                      {f.docLinks.length ? (
                        <p className={`${FX_RUN} mt-2 before:content-['In_these_docs']`} data-pagefind-ignore="">
                          {join(f.docLinks.map((l) => <a href={l.href} className={RUN_LINK}>{l.label}</a>))}
                        </p>
                      ) : null}
                      {back ? (
                        <p className={`${FX_RUN} mt-0.5 before:content-['Addressed_by']`} data-pagefind-ignore="">
                          {back.map((b) => (
                            <Fragment key={b.id}>
                              {b.n ? (
                                <a href={rm.hrefOf(b.id)} title={plain(b.title)} className={RUN_LINK}>
                                  Blocker {pad(b.n)}
                                </a>
                              ) : (
                                <Html as="a" href={rm.hrefOf(b.id)} className={RUN_LINK} html={b.title} />
                              )}{' '}
                            </Fragment>
                          ))}
                        </p>
                      ) : null}
                    </div>
                  </li>
                )
              })}
            </ul>
          </Fragment>
        )
      })}
    </Article>
  )
  return { article, rail: featureRail(rm, filter) }
}

/** A section's view (features with its filter state). */
export function sectionView(rm: Roadmap, id: SectionId, filter?: FeatureFilter, setFilter?: (f: FeatureFilter) => void): SectionView {
  switch (id) {
    case 'roadmap':
      return overview(rm)
    case 'roadmap-blockers':
      return blockers(rm)
    case 'roadmap-studio-new':
    case 'roadmap-studio-legacy':
      return studio(rm, id)
    case 'roadmap-api':
      return changes(rm, 'api')
    case 'roadmap-cli':
      return changes(rm, 'cli')
    case 'roadmap-platform':
      return changes(rm, 'studio')
    case 'roadmap-docs':
      return changes(rm, 'docs')
    case 'roadmap-later':
      return changes(rm, 'later')
    case 'roadmap-features':
      return features(rm, filter, setFilter)
    default: {
      const site = rm.REPOS.find((r) => rm.SITE_SEC[r] === id)!
      return sitePlan(rm, site)
    }
  }
}
