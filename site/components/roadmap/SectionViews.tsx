/**
 * The Roadmap's sections, one per page (a port of the former Python Roadmap generator's render functions). Router-free
 * markup: internal links are plain <a href> with the base path, and RoadmapPage turns clicks on
 * them into client-side navigation. That keeps these components renderable on their own, which
 * scripts/check-roadmap.ts does to run the page's self-checks.
 *
 * Levels: the page title is the h1, the sections' sub-headings and to-dos are h2 (the old h3),
 * feature rows are h3 (the old h4). roadmap.css styles them as before.
 *
 * Each section returns its article plus its "On this page" entries (`rail`), so the page's outline
 * comes from the data rather than from the DOM.
 */
import { createContext, Fragment, useContext, type CSSProperties, type ReactNode } from 'react'
import { Icon } from '~/components/ui/Icon'
import type { RailItem } from '~/src/lib/nav'
import { esc, GROUP_SEC, KIND, OPEN, plain, slug, VC, type Roadmap, type WorkGroup } from './model'
import type { SectionId } from './sections'

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

/** The hover permalink inside a heading (same markup as the docs' headings). */
function Anchor({ id, label }: { id: string; label: string }) {
  return (
    <a className="heading-anchor" href={`#${id}`} aria-label={`Link to ${label}`}>
      <Icon name="link" />
    </a>
  )
}

/** A plain sub-heading (h2) with its permalink; text only. */
function SubHeading({ id, children }: { id: string; children: string }) {
  return (
    <h2 id={id} aria-label={children}>
      {children}
      <Anchor id={id} label={children} />
    </h2>
  )
}

/** A to-do's heading: (number,) title. The unchecked box is CSS (decorative). */
function TodoHeading({ id, title, n }: { id: string; title: string; n?: number }) {
  const label = (n ? `${pad(n)} ` : '') + plain(title)
  return (
    <h2 id={id} aria-label={label}>
      {n ? (
        <>
          <span className="gx-n">{pad(n)}</span>{' '}
        </>
      ) : null}
      <Html html={title} />
      <Anchor id={id} label={label} />
    </h2>
  )
}
/** The rail entry for a to-do heading (its markup minus the permalink). */
const todoRail = (id: string, title: string, n?: number): RailItem => ({
  id,
  html: (n ? `<span class="gx-n">${pad(n)}</span> ` : '') + `<span>${title}</span>`,
  depth: 2,
})

/**
 * One to-do: the screen-reader "To do" (the box is drawn by CSS), its heading, then its parts. With
 * `note`, a note with nothing to do: no box, "Note" to screen readers.
 */
function Todo({ note, heading, children }: { note?: boolean; heading: ReactNode; children: ReactNode }) {
  return (
    <li className={note ? 'rm-note' : undefined}>
      <span className="rm-sr" data-pagefind-ignore="">
        {note ? 'Note' : 'To do'}
      </span>
      {heading}
      {children}
    </li>
  )
}

/**
 * Today / Plan (and link rows) as a description list. The Today row sits on the plain surface and
 * the rows after it on a fill; link-run rows (any label but Today and Plan) mark their dd.
 */
function Detail({ rows }: { rows: [label: string, body: string | ReactNode][] }) {
  return (
    <dl className="gx-wf">
      {rows.map(([lab, body], i) => {
        const run = lab !== 'Today' && lab !== 'Plan'
        // Search leaves out the labels and the link runs after the Plan (as the old index did).
        const skip = i > 0 && rows[i - 1][0] !== 'Today'
        return (
          <div key={lab} className={lab === 'Today' ? 'rm-t' : undefined} data-pagefind-ignore={skip ? '' : undefined}>
            <dt data-pagefind-ignore="">{lab}</dt>
            {typeof body === 'string' ? <Html as="dd" className={run ? 'rm-links' : undefined} html={body} /> : <dd className={run ? 'rm-links' : undefined}>{body}</dd>}
          </div>
        )
      })}
    </dl>
  )
}

/** Feature chips: links to the features' rows, named from the data, with the status for screen readers. */
function Chips({ rm, ids }: { rm: Roadmap; ids: string[] }) {
  return (
    <div className="gx-chips" data-pagefind-ignore="">
      {ids.map((id) => {
        const f = rm.FEATS[id]
        return (
          <a key={id} href={rm.hrefOf(`roadmap-f-${id}`)} data-v={VC[f.status]}>
            <span className="sr-only">{rm.VLABEL(f.status)}: </span>
            {f.name}
          </a>
        )
      })}
    </div>
  )
}

function SiteTags({ rm, repos }: { rm: Roadmap; repos: string[] }) {
  return repos.length ? <span className="gx-st">{repos.map((r) => rm.SHORT[r]).join(' · ')}</span> : null
}

/** A link to a to-do, named by its title. */
const ItemLink = ({ rm, id }: { rm: Roadmap; id: string }) => <Html as="a" href={rm.hrefOf(id)} html={rm.title(id)} />

/** A link to a work item or, with the site and step number, to a site step. */
function RefLink({ rm, id }: { rm: Roadmap; id: string }) {
  const s = rm.STEP.get(id)
  if (!s) return <ItemLink rm={rm} id={id} />
  return (
    <span className="rm-sref">
      <ItemLink rm={rm} id={id} />{' '}
      <span className="rm-ref">
        ({rm.SHORT[s.site]} step {s.n})
      </span>
    </span>
  )
}

/** Counts by status, as "<b>11</b> to build" markers. */
function Legend({ rm, ids }: { rm: Roadmap; ids: string[] }) {
  return (
    <>
      {rm
        .counts(ids)
        .filter(([, n]) => n)
        .map(([v, n]) => (
          <span key={v} className="gx-lg" data-v={VC[v]}>
            <b>{n}</b> {rm.vword(v, n)}
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

/** One status bar (all sites, or one site), with its legend and effort tally. */
function BarRow({ rm, label, labelText, ids, descHtml }: { rm: Roadmap; label: ReactNode; labelText: string; ids: string[]; descHtml?: string }) {
  const cs = rm.counts(ids).filter(([, n]) => n)
  const aria = cs.map(([v, n]) => `${n} ${rm.vword(v, n)}`).join(', ')
  return (
    <div className="gx-barrow">
      <p className="gx-bar-h" data-pagefind-ignore="">
        {label}
        <span>{ids.length} features</span>
      </p>
      <div className="gx-bar" role="img" aria-label={`${labelText}: ${aria}`} data-pagefind-ignore="">
        {cs.map(([v, n]) => (
          <i key={v} data-v={VC[v]} style={{ '--n': n } as CSSProperties} />
        ))}
      </div>
      <p className="gx-bar-l" data-pagefind-ignore="">
        <Legend rm={rm} ids={ids} />
        <span className="gx-ow" title="Effort of the features to build, to finish and left to site code">
          <OpenWork rm={rm} ids={ids} />
        </span>
      </p>
      {descHtml ? <Html as="p" className="gx-bar-d" html={descHtml} /> : null}
    </div>
  )
}

/** A status pill. */
const Pill = ({ rm, v, own = true }: { rm: Roadmap; v: string; own?: boolean }) => (
  <b className="gx-vp" data-v={own ? VC[v] : undefined}>
    {rm.VLABEL(v)}
  </b>
)

/** The status key for chip dots (the to-build marker is a diamond, so it doesn't rely on colour). */
function Key({ rm }: { rm: Roadmap }) {
  return (
    <span className="gx-key">
      {rm.VERDICTS.filter((v) => rm.TOTALS[v]).map((v) => (
        <span key={v} className="gx-lg" data-v={VC[v]}>
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

/** The section's article: eyebrow (with its count), h1, lede, the inline outline, then the body. */
function Article({ rm, id, cls, count, lede, children }: { rm: Roadmap; id: SectionId; cls?: string; count?: string; lede: ReactNode; children: ReactNode }) {
  const s = rm.SEC[id]
  return (
    <article id={id} className={`doc-section doc-page gx-sec${cls ? ` ${cls}` : ''}`} aria-labelledby={`${id}-title`} data-pagefind-body="">
      <p className="eyebrow">
        {s.eyebrow}
        {count ? (
          <span className="rm-count" data-pagefind-ignore="">
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
  const head = (id: string, text: string): RailItem => ({ id, html: esc(text), depth: 2 })
  const article = (
    <Article rm={rm} id="roadmap" lede={<Html as="p" html={ledeHtml} />}>
      {restHtml.map((h, i) => (
        <Html key={i} as="p" html={h} />
      ))}
      {rm.OV.fix_now ? (
        <div className="gx-now rm-do">
          <Html as="p" html={`<span class="rm-sr" data-pagefind-ignore="">To do: </span>${rm.OV.fix_now}`} />
        </div>
      ) : null}
      <SubHeading id="roadmap--the-ten-release-blockers">The ten release blockers</SubHeading>
      <p>{blockerLede(rm)} Each links to where it stands today, the plan and the work items that deliver it.</p>
      <ol className="gx-toplist">
        {rm.TOP.map((g) => (
          <li key={g.id}>
            <span className="rm-sr" data-pagefind-ignore="">
              To do:{' '}
            </span>
            <ItemLink rm={rm} id={g.id} />
            <span className="gx-tl-s" data-pagefind-ignore="">
              {g.features.length} features
            </span>
          </li>
        ))}
      </ol>
      <SubHeading id="roadmap--release-readiness">Release readiness</SubHeading>
      <Html as="p" html={rm.OV.readiness_lead} />
      <ul className="gx-tiles" aria-label="Features by status">
        {rm.VERDICTS.map((v) => (
          <li key={v} data-v={VC[v]}>
            <span className="gx-tile-n">{T[v]}</span>
            <Pill rm={rm} v={v} own={false} />
            <span className="gx-tile-d">{rm.status(v).tile}</span>
          </li>
        ))}
      </ul>
      <div className="gx-bars">
        <BarRow rm={rm} label={<b>All three sites</b>} labelText="All three sites" ids={rm.FIDS} />
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
      <p className="gx-note">
        Each bar counts the features in its scope: all three sites, then each site. Open work counts the features still to build, finish or leave to site code, by relative effort: S, M or L. Short
        names on this page: {join(shorts.slice(0, -1), ', ')} and {shorts[shorts.length - 1]}.
      </p>
      <div className="callout warning rm-do">
        <Html as="p" html={`<span class="rm-sr" data-pagefind-ignore="">To do: </span>${rm.OV.fix_docs}`} />
      </div>
      <SubHeading id="roadmap--using-this-page">Using this page</SubHeading>
      <ul className="gx-map">
        <li>
          <a href={rm.hrefOf('roadmap-blockers')}>Release blockers</a>: the ten items that gate the release, each with where it stands today, the plan and the work items that deliver it.
        </li>
        <li>
          <a href={rm.hrefOf('roadmap-studio-new')}>Studio support</a>: what has to work for editors, on a next-major site and with legacy content ({nStudio} items).
        </li>
        <li>
          <a href={rm.hrefOf('roadmap-api')}>Work items</a>: {rm.CHANGES.length} changes, deduplicated from the {n} per-feature proposals, in four groups: the API, the CLI, Studio and the Deco
          API, and these docs.
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
      <p className="small muted">
        How this list was made: each site's features were catalogued from its code, with file and line evidence, and grouped into {rm.CATS.length} categories. Each feature was then assessed against
        these docs, and a second reviewer checked each assessment against Studio's and the framework's code. That check changed {F.filter((f) => f.first_rated).length} statuses, all to “to finish”,
        and a later review changed {F.filter((f) => f.rated_before_review).length} more. {F.filter((f) => f.confidence !== 'high').length} of the {n} assessments are medium confidence and the rest
        are high, and {F.filter((f) => f.unconfirmed_sub_claim).length} contain a sub-claim the second reviewer couldn't confirm. Feature readiness marks each of these on its row.
      </p>
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
      cls="gx-items"
      count={`${rm.TOP.length} to do`}
      lede={<p>{blockerLede(rm)} Each says where things stand today, the plan, and the work items that deliver it; the chips link to the affected features.</p>}
    >
      <ol className="rm-list">
        {rm.TOP.map((g, i) => {
          const h = rm.html.blocker.get(g.id)!
          return (
            <Todo key={g.id} heading={<TodoHeading id={g.id} title={g.title} n={i + 1} />}>
              {rm.allSitesBlockers ? null : (
                <p className="gx-meta" data-pagefind-ignore="">
                  <SiteTags rm={rm} repos={rm.sitesOf(g.features)} />
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
                          <Html className="rm-dnote" html={h.note} />
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
    <Article rm={rm} id={id} cls="gx-items" count={`${items.length} to do`} lede={<p>{STUDIO_LEDE[id]}</p>}>
      <ul className="rm-list">
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
  }[key]
  const article = (
    <Article
      rm={rm}
      id={id}
      cls="gx-items"
      count={`${items.length} to do`}
      lede={
        <p>
          {lede} A chip's dot shows that feature's status: <Key rm={rm} />.
        </p>
      }
    >
      <ul className="rm-list">
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
              <p className="gx-meta" data-pagefind-ignore="">
                <span className="gx-meta-n">{nf}</span>
                <SiteTags rm={rm} repos={rm.sitesOf(ids)} />
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
    <Article rm={rm} id={id} cls="gx-items gx-plan" count={count} lede={<Html as="p" html={rm.HEADLINE[r]} />}>
      <Html as="p" className="gx-sitedesc" html={`<span class="gx-meta-k" data-pagefind-ignore="">The site</span>${rm.REPO_DESC[r]}`} />
      <div className="gx-bars">
        <BarRow rm={rm} label={<b>{rm.NAME[r]}</b>} labelText={rm.NAME[r]} ids={ids} />
      </div>
      <p>
        The steps are in execution order, each tagged: <b>Fix now</b> (a live bug, migration or not), <b>Before migrating</b> (an upgrade that comes first), <b>Blocker</b> (must be solved before this
        site can move; separate from the ten release blockers), <b>Site work</b>, <b>Content</b> (stored content and data shapes), and <b>Note</b>.{nNote ? ' A note with nothing to do has no box.' : ''}{' '}
        <a href={rm.hrefOf('roadmap-features')} data-gx-site={rm.SHORT[r]}>
          See where the {ids.length} features it uses stand
        </a>
        .
      </p>
      <ol className="rm-list">
        {steps.map((s, i) => (
          <Todo key={s.id} note={s.no_action} heading={<TodoHeading id={s.id} title={s.title} n={i + 1} />}>
            <p className="gx-meta" data-pagefind-ignore="">
              <span className="gx-kind" data-k={s.kind}>
                {KIND[s.kind]}
              </span>
            </p>
            <Html as="p" html={rm.html.step.get(s.id)!.text} />
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

function RowTags({ rm, fid }: { rm: Roadmap; fid: string }) {
  // The earlier statuses are ratings the assessment gave and later corrected, not progress that
  // was undone, so the tags name the rating ("First rated …") rather than a past state ("Was …").
  const f = rm.FEATS[fid]
  return (
    <>
      {f.confidence !== 'high' ? <i className="gx-tg">Medium confidence</i> : null}
      {f.first_rated ? (
        <i className="gx-tg" title="The assessor's first rating; verification against the code changed it">
          First rated {rm.vq(f.first_rated)}
        </i>
      ) : null}
      {f.rated_before_review ? (
        <i className="gx-tg" title="The status a later review changed">
          Rated {rm.vq(f.rated_before_review)} before review
        </i>
      ) : null}
      {f.unconfirmed_sub_claim ? (
        <i className="gx-tg" title="Contains a sub-claim the verifier couldn't confirm">
          Unconfirmed sub-claim
        </i>
      ) : null}
    </>
  )
}

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
            <span>{n}</span>
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
      cls="gx-index"
      count={`${done} of ${all.length - gone} done · ${gone} go away`}
      lede={
        <p>
          All {all.length} features the three sites use, grouped into {rm.CATS.length} categories, and where each one stands. Within a category, features to build come first, then those to finish,
          left to site code and going away, each ordered by effort (L, M, S). Each row names the parts of these docs the feature concerns and, below that, the release blockers and work items that
          address it. Feature chips elsewhere on this page link to these rows.
        </p>
      }
    >
      <dl className="rm-legend" aria-label="Statuses">
        {rm.VERDICTS.map((v) => (
          <div key={v}>
            <dt>
              <b className="gx-lg" data-v={VC[v]}>
                {rm.VLABEL(v)}
              </b>
            </dt>
            <Html as="dd" html={rm.status(v).legend} />
          </div>
        ))}
      </dl>
      {/* Without JavaScript the filter does nothing, so roadmap.css hides it unless <html> has the
          `js` class (set by the inline head script before first paint, so it never shifts the list). */}
      <div className="gx-filter" data-pagefind-ignore="">
        <div className="gx-fg" role="group" aria-label="Filter by status">
          <span className="gx-fl">Status</span>
          {btn('v', '', 'All statuses', { count: false })}
          {rm.VERDICTS.filter((v) => T[v]).map((v) =>
            btn(
              'v',
              VC[v],
              <>
                <i data-v={VC[v]} />
                {rm.VLABEL(v)}
              </>,
            ),
          )}
        </div>
        <div className="gx-fg" role="group" aria-label="Filter by site">
          <span className="gx-fl">Site</span>
          {btn('s', '', 'All sites', { count: false })}
          {rm.REPOS.map((r) => btn('s', rm.SHORT[r], rm.SHORT[r], { title: rm.NAME[r] }))}
        </div>
        <p className="gx-fcount" aria-live="polite">
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
            <h2 id={hid} aria-label={cat.title} hidden={off}>
              {cat.title}
              <Anchor id={hid} label={cat.title} />
            </h2>
            <p className="gx-catd" hidden={off}>
              {ids.length} feature{ids.length !== 1 ? 's' : ''} · {cat.description}
              <span className="gx-catc" data-pagefind-ignore="">
                <Legend rm={rm} ids={ids} />
              </span>
            </p>
            <ul className="gx-fx" hidden={off}>
              {ids.map((fid) => {
                const f = rm.feature(fid)
                const back = rm.BACK.get(fid)
                return (
                  <li key={fid} id={`roadmap-f-${fid}`} data-v={f.v} hidden={!shown(rm, fid, filter)}>
                    <h3>{f.name}</h3>
                    <p className="gx-fx-m" data-pagefind-ignore="">
                      <Pill rm={rm} v={f.status} own={false} />
                      <span>Effort {f.effort}</span>
                      <SiteTags rm={rm} repos={f.sites} />
                      <RowTags rm={rm} fid={fid} />
                    </p>
                    <div>
                      <Html as="p" html={f.summaryHtml} />
                      {f.docLinks.length ? (
                        <p className="gx-fx-d" data-pagefind-ignore="">
                          {join(f.docLinks.map((l) => <a href={l.href}>{l.label}</a>))}
                        </p>
                      ) : null}
                      {back ? (
                        <p className="gx-fx-c" data-pagefind-ignore="">
                          {back.map((b) => (
                            <Fragment key={b.id}>
                              {b.n ? (
                                <a href={rm.hrefOf(b.id)} title={plain(b.title)}>
                                  Blocker {pad(b.n)}
                                </a>
                              ) : (
                                <Html as="a" href={rm.hrefOf(b.id)} html={b.title} />
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
    case 'roadmap-features':
      return features(rm, filter, setFilter)
    default: {
      const site = rm.REPOS.find((r) => rm.SITE_SEC[r] === id)!
      return sitePlan(rm, site)
    }
  }
}
