/**
 * The current release's bands under the hero: stack strip, "How v7 works" cards, the production
 * band, the commerce apps grid, Fast Deploy publishing, moving to v7, looking ahead, and the final
 * CTA. Built from the next major's pieces (../Sections.tsx, ../ui.tsx); only copy and mockups differ.
 */
import { Icon, Mark, type IconName, type MarkName } from '~/components/ui/Icon'
import { MdxLink } from '~/components/mdx/MdxLink'
import { Cobogo } from '../Hero'
import {
  bracket,
  c,
  cap,
  card,
  cardH3,
  cardNum,
  cardP,
  chip,
  ciVisual,
  ciWin,
  hairlineGrid,
  lane,
  laneGrid,
  LaneLabel,
  linked,
  linkedFar,
  mfLabel,
  mfRow,
  notes,
  Point,
  PubPoint,
  step,
  stepBox,
  stepPlain,
  stepSkip,
  stIcon,
  stKey,
  stPill,
  stRow,
  tag,
} from '../Sections'
import {
  btnOutline,
  btnPrimary,
  container,
  cta,
  d,
  devLink,
  devLinkIcon,
  Dim,
  Dots,
  H2,
  Kicker,
  Lede,
  lsec,
  mono,
  reveal,
  section,
  sectionHead,
  textLink,
  textLinkIcon,
  win,
  winBar,
  winBarSmall,
  winTitle,
  winTitleSmall,
} from '../ui'

const STACK: [MarkName, string][] = [
  ['tanstack', 'TanStack Start'],
  ['cloudflare', 'Cloudflare Workers'],
  ['nextjs', 'Next.js App Router'],
  ['react', 'React 19'],
  ['node', 'Node.js 24+'],
  ['git', 'Content in your repo'],
]

export function V7StackStrip() {
  return (
    <div>
      <div className={`${container} pt-18 pb-20 max-sm:py-14`}>
        <Kicker className={`text-center ${reveal}`}>Runs on your stack</Kicker>
        <ul className={`${hairlineGrid} list-none mt-8 p-0 grid-cols-6 max-xl:grid-cols-3 max-md:grid-cols-2 ${reveal}`} style={d('80ms')} aria-label="Runtimes">
          {STACK.map(([mark, label]) => (
            <li
              className="h-24 flex items-center justify-center gap-2.5 px-3 bg-bg text-15 font-medium tracking-snug text-stack-fg text-center transition-colors duration-300 hover:bg-stack-hover hover:text-tint-fg max-md:h-20 max-md:text-14"
              key={mark}
            >
              <Mark name={mark} className="size-[18px] flex-none" />
              {label}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/** "Read: …" link under a card. */
function CardLink({ href, children }: { href: string; children: string }) {
  return (
    <MdxLink className={`${textLink} text-link mt-4`} href={href}>
      {children}
      <Icon name="arrow-right" className={textLinkIcon} />
    </MdxLink>
  )
}

const fileRow = 'flex items-center gap-2 py-[5px] text-12 leading-5'

export function ThreeRoles() {
  return (
    <div className={lsec}>
      <div className={`${container} ${section}`}>
        <div className={sectionHead}>
          <Kicker className={reveal}>How v7 works</Kicker>
          <H2 className={reveal} style={d('60ms')}>
            Developers build the pieces. <Dim>Editors assemble the pages.</Dim>
          </H2>
          <Lede className={reveal} style={d('120ms')}>
            A section is a React component with typed props. A page is a list of sections stored as JSON in your repository. Studio turns the
            types into forms, so a launch, a banner swap or an A/B test is an edit, not a ticket.
          </Lede>
        </div>
        <div className={`${hairlineGrid} grid-cols-3 max-home-xl:grid-cols-1 ${reveal}`} style={d('160ms')}>
          <div className={card}>
            <div className={`${ciWin} bg-code-bg`} aria-hidden="true" data-pagefind-ignore="">
              <div className={winBarSmall}>
                <Dots small />
                <span className={winTitleSmall}>src/sections/</span>
              </div>
              <div className={`px-4 py-3 ${mono}`}>
                <div className={fileRow}>
                  <Icon name="file" className="size-[13px] text-eyebrow" />
                  <span className="text-fg">Hero.tsx</span>
                </div>
                <div className={fileRow}>
                  <Icon name="file" className="size-[13px] text-eyebrow" />
                  <span className="text-fg">ProductShelf.tsx</span>
                </div>
                <div className={fileRow}>
                  <Icon name="layers" className="size-[13px] text-eyebrow" />
                  <span className="text-fg">Header/Header.tsx</span>
                </div>
                <div className="mt-2 pt-2.5 border-t border-hairline text-12 leading-5">
                  <span className="text-syn-comment italic">// Header.tsx</span>
                  <br />
                  <span className="text-syn-keyword">export const</span> <span className="text-syn-property">layout</span> ={' '}
                  <span className="text-syn-keyword">true</span>;
                </div>
              </div>
            </div>
            <div>
              <span className={cardNum}>01</span>
              <h3 className={cardH3}>Sections in TypeScript</h3>
              <p className={cardP}>
                Write React 19 components and type their props. One <code>generate</code> command builds the schema Studio reads, along with
                the registries your site loads. Section loaders fetch data on the server before render.
              </p>
              <CardLink href="/v7/model">Blocks and sections</CardLink>
            </div>
          </div>
          <div className={card}>
            <div className={`${ciWin} bg-surface`} aria-hidden="true" data-pagefind-ignore="">
              <div className={winBarSmall}>
                <Dots small />
                <span className={winTitleSmall}>Studio — Summer sale</span>
              </div>
              <div className="py-1 px-3.5">
                <div className={mfRow}>
                  <span className={mfLabel}>Path</span>
                  <span className={`h-8 flex items-center px-3 border rounded-full bg-surface min-w-0 whitespace-nowrap overflow-hidden ${mono} text-12.5 border-border text-fg`}>
                    /summer-sale
                  </span>
                </div>
                <div className={`${mfRow} border-t border-hairline items-start`}>
                  <span className={`${mfLabel} pt-1.5`}>Sections</span>
                  <span className="grid gap-1.5">
                    <span className="flex gap-1.5 flex-wrap">
                      <span className={`${chip} bg-tint font-mono text-tint-fg`}>Hero</span>
                      <span className={`${chip} bg-tint font-mono text-tint-fg gap-1.5`}>
                        ProductShelf
                        <Icon name="zap" className="size-3" />
                      </span>
                      <span className={`${chip} bg-transparent border border-dashed border-border-strong text-muted-fg font-sans`}>+ Add</span>
                    </span>
                    <span className="inline-flex items-center gap-2 text-11.5 leading-4 text-muted-fg">
                      <span className="relative inline-block w-7 h-4 rounded-full bg-pub-live-bg" aria-hidden="true">
                        <i className="absolute top-0.5 right-0.5 size-3 rounded-full bg-white" />
                      </span>
                      ProductShelf · Load async
                    </span>
                  </span>
                </div>
              </div>
            </div>
            <div>
              <span className={cardNum}>02</span>
              <h3 className={cardH3}>Pages in Studio</h3>
              <p className={cardP}>
                Editors create pages at any path, reorder sections, schedule content, and preview drafts on the real site before publishing.
                Studio talks to your running site over a small, documented protocol.
              </p>
              <CardLink href="/v7/studio">Deco Studio and the admin protocol</CardLink>
            </div>
          </div>
          <div className={card}>
            <div
              className={`${ciVisual} border bg-bg-warm p-4 flex flex-col justify-center gap-2 max-sm:py-3 max-sm:px-3.5`}
              aria-hidden="true"
              data-pagefind-ignore=""
            >
              <div className="flex-none border border-hairline rounded-xl bg-surface overflow-hidden">
                <div className="flex items-center gap-2 h-8 px-3 border-b border-hairline text-12 leading-4 text-muted-fg whitespace-nowrap overflow-hidden">
                  <Icon name="git-branch" className="size-[13px] text-eyebrow" />
                  <span className="min-w-0 overflow-hidden text-ellipsis">Multivariate · Home hero</span>
                </div>
                <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-3 py-2 text-12 leading-5">
                  <span className="text-fg">
                    <Icon name="smartphone" className="inline size-3 mr-1 align-[-1px] text-eyebrow" />
                    Mobile
                  </span>
                  <span className="text-quiet">→</span>
                  <span className="font-mono text-11.5 text-tint-fg">HeroMobile</span>
                </div>
                <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-3 py-2 border-t border-hairline text-12 leading-5">
                  <span className="text-fg">
                    <Icon name="sliders" className="inline size-3 mr-1 align-[-1px] text-eyebrow" />
                    Random 50%
                  </span>
                  <span className="text-quiet">→</span>
                  <span className="font-mono text-11.5 text-tint-fg">Hero B</span>
                </div>
              </div>
              <div className="self-end max-w-[80%] -rotate-1 px-3 py-2 rounded-lg bg-[color-mix(in_oklab,var(--yellow)_28%,var(--surface))] text-fg text-12 leading-[17px] shadow-sm">
                <span className="block font-mono text-10.5 leading-3.5 text-muted-fg">deco_segment</span>
                Same visitor, same variant
              </div>
            </div>
            <div>
              <span className={cardNum}>03</span>
              <h3 className={cardH3}>Variants without code</h3>
              <p className={cardP}>
                Matchers pick what each visitor sees: device, date, cookie, location, URL or a random split that stays sticky per visitor. Add
                your own matcher in a few lines.
              </p>
              <CardLink href="/v7/variants">Matchers and variants</CardLink>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

const HEADERS: [string, string, 'live' | 'tint'][] = [
  ['X-Cache', 'STALE-HIT · revalidating', 'live'],
  ['X-Cache-Profile', 'listing', 'tint'],
  ['X-Cache-Segment', '9f2c41e7', 'tint'],
  ['X-Trace-Id', 'trace id attached', 'tint'],
]

export function Production() {
  return (
    <div className={lsec}>
      <div className="mx-auto w-full max-w-landing px-10 py-8 max-sm:px-2 max-sm:py-4">
        <div className="relative isolate overflow-hidden pt-22 px-18 pb-20 rounded-3xl text-band-fg [background-image:radial-gradient(700px_500px_at_85%_10%,rgba(30,110,55,.5),transparent_60%),linear-gradient(162deg,#145528_0%,#0C4420_50%,#07301A_100%)] max-xl:py-18 max-xl:px-12 max-sm:pt-14 max-sm:px-5 max-sm:pb-12 max-sm:rounded-2xl [&_:where(:focus-visible)]:outline-lime">
          <Cobogo className="top-0 h-full [mask-image:linear-gradient(to_right,transparent_0%,transparent_62%,#000_92%)]" />
          <div className="relative max-w-[900px] mb-[52px]">
            <Kicker band className={reveal}>
              Built for production
            </Kicker>
            <H2 band className={reveal} style={d('60ms')}>
              Fast at the edge. <Dim band className="min-home-sm:block">Observable when it isn't.</Dim>
            </H2>
            <Lede band className={reveal} style={d('120ms')}>
              On Cloudflare Workers, the TanStack binding wraps your site in a cache-aware Worker. Pages are cached by visitor segment,
              revalidated in the background, and served stale if an upstream fails. Spans, logs and metrics come built in.
            </Lede>
          </div>
          <div className="relative grid grid-cols-[minmax(0,1fr)_minmax(0,1.04fr)] grid-rows-[auto_1fr] gap-x-16 items-start max-xl:gap-x-12 max-nav:grid-cols-1 max-nav:grid-rows-none max-nav:gap-y-10">
            <div
              className={`${win} bg-surface col-[2] row-[1/span_2] rounded-2xl border-[rgba(255,255,255,.14)] shadow-[0_0_0_1px_rgba(0,0,0,.05),0_44px_90px_-34px_rgba(0,0,0,.6)] max-nav:col-[1] max-nav:row-auto ${reveal}`}
              style={d('160ms')}
              role="group"
              aria-labelledby="headers-title"
              data-pagefind-ignore=""
            >
              <div className={winBar}>
                <Dots hidden />
                <span className={winTitle} id="headers-title">
                  store.example.com — response headers
                </span>
              </div>
              <div className="pt-4 px-[22px] pb-2 max-home-sm:px-3.5 max-home-sm:pb-1.5">
                <ul className="list-none m-0 p-0" role="list">
                  {HEADERS.map(([key, value, kind], i) => (
                    <li className={`${stRow} ${i ? 'border-t border-hairline' : ''}`} key={key}>
                      <span className={`${stKey} font-mono text-13`}>{key}</span>
                      {kind === 'live' ? (
                        <span className={`${stPill} bg-pill-on-bg text-pill-on-fg shadow-[inset_0_0_0_1px_var(--pill-on-ring)]`}>
                          <i className="size-[7px] rounded-full flex-none bg-lime shadow-[0_0_0_3px_rgba(208,236,26,.22)]" aria-hidden="true" />
                          {value}
                        </span>
                      ) : (
                        <span className={`${stPill} bg-tint text-tint-fg ${key === 'X-Cache-Segment' ? 'font-mono' : ''}`}>
                          <Icon name="check" strokeWidth={2.25} className={stIcon} />
                          {value}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 mb-3 text-center text-12.5 leading-[18px] text-muted-fg">Every response tells you how it was served.</p>
              </div>
            </div>
            <ul className={`col-[1] row-[1] list-none m-0 p-0 border-b border-band-line max-nav:row-auto ${reveal}`} style={d('200ms')} role="list">
              <Point title="Cache profiles per page type">
                Product, listing, search, static and private pages each get edge, browser and loader policies. Cart and account pages are never
                shared.
              </Point>
              <Point title="Logged-in visitors stay private">
                Logged-in visitors always bypass the shared cache, and tracking parameters never split it.
              </Point>
              <Point title="Deferred sections">
                Editors mark slow sections async. Visitors get the page first and the rest as they scroll, while crawlers get everything.
              </Point>
              <Point title="Observability included">
                Request spans, cache decisions and upstream commerce timings, exported to your own OpenTelemetry collector.
              </Point>
            </ul>
            <div className={`col-[1] row-[2] max-nav:row-auto max-nav:-mt-1 ${reveal}`}>
              <p className={`${devLink} text-lime`}>
                <span className="font-normal text-band-muted">For developers:</span>{' '}
                <MdxLink className="text-lime no-underline hover:underline" href="/v7/caching">
                  caching
                </MdxLink>{' '}
                <span className="font-normal text-band-muted">·</span>{' '}
                <MdxLink className="text-lime no-underline hover:underline" href="/v7/observability">
                  <span className="whitespace-nowrap">
                    observability
                    <Icon name="arrow-right" className={devLinkIcon} />
                  </span>
                </MdxLink>
              </p>
              <p className="mt-4 max-w-[46ch] text-13 leading-5 text-band-muted">
                The edge cache and Fast Deploy are features of the TanStack Start + Cloudflare Workers binding. Next.js sites use Next's own
                rendering and caching.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

const APPS: { href: string; name: string; line: string; tag: string; icon: IconName }[] = [
  { href: '/v7/vtex', name: 'VTEX', line: 'Catalog, search, cart, account, checkout proxy', tag: 'Full', icon: 'box' },
  { href: '/v7/shopify', name: 'Shopify', line: 'Storefront API products, cart and sign-in', tag: 'Full', icon: 'box' },
  { href: '/v7/wake', name: 'Wake', line: 'Catalog, cart, wishlist and checkout routes', tag: 'Full', icon: 'box' },
  { href: '/v7/magento', name: 'Magento', line: 'Cart, user and wishlist; catalog in progress', tag: 'Partial', icon: 'box' },
  { href: '/v7/salesforce', name: 'Salesforce', line: 'Personalization product recommendations', tag: 'Recommendations', icon: 'sparkle' },
  { href: '/v7/algolia', name: 'Algolia', line: 'Shared search client for your own loaders', tag: 'Client only', icon: 'search' },
  { href: '/v7/blog', name: 'Blog', line: 'Posts, categories and SEO from your content', tag: 'Content', icon: 'book' },
  { href: '/v7/resend', name: 'Resend', line: 'Transactional email from forms', tag: 'Email', icon: 'zap' },
  { href: '/v7/apps-website', name: 'Website', line: 'SEO, analytics, themes and fonts', tag: 'Every site', icon: 'globe' },
]

export function CommerceApps() {
  return (
    <div className={lsec}>
      <div className={`${container} ${section}`}>
        <div className={sectionHead}>
          <Kicker className={reveal}>Companion apps</Kicker>
          <H2 className={reveal} style={d('60ms')}>
            Commerce included. <Dim>Bring your platform.</Dim>
          </H2>
          <Lede className={reveal} style={d('120ms')}>
            Apps are packages that plug a platform into your site: loaders for product pages, listings and search, actions for cart and
            account, configured from a block in your content. Every app speaks the same schema.org-shaped commerce types, so your sections
            don't care which backend fills them.
          </Lede>
        </div>
        <ul className={`${hairlineGrid} list-none m-0 p-0 grid-cols-3 max-home-lg:grid-cols-2 max-home-sm:grid-cols-1 ${reveal}`} style={d('160ms')} role="list">
          {APPS.map((a) => (
            <li className="min-w-0 bg-bg" key={a.href}>
              <MdxLink
                className="group h-full grid grid-cols-[32px_minmax(0,1fr)] gap-x-3 pt-5 px-6 pb-6 no-underline text-inherit transition-colors duration-300 hover:bg-bg-subtle max-home-sm:px-4 max-home-sm:pt-4 max-home-sm:pb-5"
                href={a.href}
              >
                <span className="size-8 grid place-items-center rounded-lg bg-tint text-tint-fg" aria-hidden="true">
                  <Icon name={a.icon} className="size-4" />
                </span>
                <span className="min-w-0 grid gap-1">
                  <span className="flex flex-wrap items-center justify-between gap-2">
                    <strong className="text-17 leading-6 font-normal tracking-ui text-fg group-hover:text-link">{a.name}</strong>
                    <span className={`${tag} shadow-[inset_0_0_0_1px_var(--border-strong)] text-muted-fg`}>{a.tag}</span>
                  </span>
                  <span className="text-14 leading-[1.55] text-muted-fg">{a.line}</span>
                </span>
              </MdxLink>
            </li>
          ))}
        </ul>
        <MdxLink className={`${textLink} text-link mt-8 ${reveal}`} href="/v7/apps">
          How apps work
          <Icon name="arrow-right" className={textLinkIcon} />
        </MdxLink>
      </div>
    </div>
  )
}

export function FastDeploy() {
  return (
    <div className={lsec}>
      <div className={`${container} ${section}`}>
        <div className={sectionHead}>
          <Kicker className={reveal}>Fast Deploy · optional, Workers only</Kicker>
          <H2 className={reveal} style={d('60ms')}>
            Publish in seconds, <Dim>not on the next deploy.</Dim>
          </H2>
          <Lede className={reveal} style={d('120ms')}>
            By default, content ships inside each deploy, so your site always has a tested copy. Turn on Fast Deploy and Studio publishes go
            to Cloudflare KV instead. Every Worker picks up the new content on its next check, while a code deploy still reads its own
            snapshot.
          </Lede>
        </div>
        <div className={`${win} bg-surface border-hairline shadow-win rounded-2xl ${reveal}`} style={d('160ms')} aria-hidden="true" data-pagefind-ignore="">
          <div className={winBar}>
            <Dots />
            <span className={`${winTitle} max-home-sm:left-16 max-home-sm:right-3.5 max-home-sm:text-right`}>Publishing a change — store.example.com</span>
          </div>
          <div className="max-home:grid max-home:grid-cols-2 max-home:grid-rows-[auto_auto_auto]">
            <div className={lane}>
              <LaneLabel title="Default" sub="content ships with your next deploy" />
              <ol className={`${laneGrid} list-none m-0 p-0 max-home:grid-rows-[repeat(6,38px)] max-home:gap-y-(--gap) max-home:justify-items-stretch`}>
                <li style={c(1)} className={`${step} ${stepPlain}`}>
                  Edit
                </li>
                <li style={c(3)} className={`${step} ${stepPlain} ${linkedFar}`}>
                  Commit
                </li>
                <li style={c(4)} className={`${step} ${stepPlain} ${linked}`}>
                  Build
                </li>
                <li style={c(5)} className={`${step} ${stepPlain} ${linked}`}>
                  Deploy
                </li>
                <li style={c(6)} className={`${step} ${stepPlain} ${linked}`}>
                  Live
                </li>
              </ol>
              <div className={notes}>
                <span className={bracket}>code release</span>
                <span className={cap}>at your next deploy</span>
              </div>
            </div>
            <div className={`${lane} border-t border-hairline bg-[color-mix(in_oklab,var(--tint)_70%,var(--surface))] max-home:border-t-0 max-home:border-l`}>
              <LaneLabel title="With Fast Deploy" sub="content served from KV" />
              <ol className={`${laneGrid} list-none m-0 p-0 max-home:grid-rows-[repeat(6,38px)] max-home:gap-y-(--gap) max-home:justify-items-stretch`}>
                <li style={c(1)} className={`${step} ${stepPlain}`}>
                  Edit
                </li>
                <li style={c(3)} className={`${step} ${stepPlain} ${linkedFar}`}>
                  Publish
                </li>
                <li style={c(4)} className={`${step} ${stepSkip} ${linked} max-home:hidden`}>
                  Build
                </li>
                <li style={c(5)} className={`${step} ${stepSkip} ${linked} max-home:hidden`}>
                  Deploy
                </li>
                {/* Below 1000px, Build and Deploy collapse into this one pill spanning their rows. */}
                <li
                  className={`${stepBox} ${stepSkip} ${linked} hidden max-home:flex max-home:row-[4/6] max-home:self-stretch px-2.5 max-home-lg:px-2 max-home:text-13 max-home:leading-[17px] max-home:no-underline max-home:rounded-[18px] max-home:text-fg max-home-sm:px-1.5`}
                >
                  No build · no deploy
                </li>
                <li style={c(6)} className={`${step} ${linked} border-transparent bg-pub-live-bg text-pub-live-fg shadow-[0_6px_18px_-8px_rgba(7,64,26,.55)]`}>
                  Live
                </li>
              </ol>
              <div className={notes}>
                <span className={`${bracket} before:border-dashed`}>no build · no deploy</span>
                <span className={`${cap} font-medium text-tint-fg`}>live within seconds</span>
              </div>
            </div>
          </div>
        </div>
        <ul className={`${hairlineGrid} list-none mt-7 p-0 grid-cols-3 max-home-lg:grid-cols-2 max-home-sm:grid-cols-1 ${reveal}`} style={d('200ms')} role="list">
          <PubPoint title="Keyed to each deployment">New code never reads old content, and a rollback brings its own content back.</PubPoint>
          <PubPoint title="Safe fallback">If KV can't be read, the site serves the content bundled with the deploy.</PubPoint>
          <PubPoint title="Preview first">
            Draft links render unpublished changes on allow-listed hosts, and nothing is cached or indexed.
          </PubPoint>
        </ul>
        <MdxLink className={`${devLink} text-link ${reveal}`} href="/v7/releases">
          <span className="font-normal text-muted-fg">For developers:</span> deploying and Fast{' '}
          <span className="whitespace-nowrap">
            Deploy
            <Icon name="arrow-right" className={devLinkIcon} />
          </span>
        </MdxLink>
      </div>
    </div>
  )
}

export function MoveToV7() {
  const cardLink =
    'group relative grid grid-cols-[minmax(0,1fr)_20px] items-start gap-x-4 pt-6 px-7 pb-7 bg-bg no-underline text-inherit transition-colors duration-300 hover:bg-bg-subtle max-sm:px-4 max-sm:pt-5 max-sm:pb-6'
  return (
    <div className={`${lsec} bg-bg-subtle`}>
      <div className={`${container} ${section}`}>
        <div className={sectionHead}>
          <Kicker className={reveal}>Already on Deco?</Kicker>
          <H2 className={reveal} style={d('60ms')}>
            Bring your site along.
          </H2>
        </div>
        <div className={`${hairlineGrid} grid-cols-2 max-nav:grid-cols-1 ${reveal}`} style={d('120ms')}>
          <MdxLink className={cardLink} href="/v7/migrate-from-fresh">
            <span className="grid gap-2">
              <strong className="text-19 leading-[1.3] font-normal tracking-[-.012em] text-fg group-hover:text-link">From Fresh and Deno</strong>
              <span className="text-14.5 leading-[1.6] text-muted-fg">
                <code>deco-migrate</code> rewrites a Fresh site to TanStack Start and React 19 in place: imports, JSX, Tailwind 4, routes and
                the Worker entry. A post-migration audit tells you what's left.
              </span>
            </span>
            <Icon name="arrow-right" className="size-[18px] mt-1 text-olive-ring transition-[translate,color] duration-400 ease-out-quart group-hover:translate-x-1 group-hover:text-eyebrow" />
          </MdxLink>
          <MdxLink className={cardLink} href="/v7/upgrade-from-start">
            <span className="grid gap-2">
              <strong className="text-19 leading-[1.3] font-normal tracking-[-.012em] text-fg group-hover:text-link">From @decocms/start 6.x</strong>
              <span className="text-14.5 leading-[1.6] text-muted-fg">
                <code>deco-upgrade-6-to-7</code> rewrites your imports to the split packages and updates <code>package.json</code>. A checklist
                covers the rest.
              </span>
            </span>
            <Icon name="arrow-right" className="size-[18px] mt-1 text-olive-ring transition-[translate,color] duration-400 ease-out-quart group-hover:translate-x-1 group-hover:text-eyebrow" />
          </MdxLink>
        </div>
        <MdxLink className={`${textLink} text-link mt-8 ${reveal}`} href="/v7/nextjs-from-start">
          <span className="font-normal text-muted-fg">On Next.js with @decocms/start 5.x?</span> Move to the split packages
          <Icon name="arrow-right" className={textLinkIcon} />
        </MdxLink>
      </div>
    </div>
  )
}

export function LookingAhead() {
  return (
    <div className={lsec}>
      <div className={`${container} py-14 max-sm:py-10`}>
        <div
          className={`flex flex-wrap items-center justify-between gap-x-10 gap-y-5 rounded-box border border-preview-border bg-preview-bg px-7 py-6 max-sm:px-4 max-sm:py-5 ${reveal}`}
        >
          <p className="m-0 max-w-[68ch] flex gap-3 text-15 leading-[1.6] text-fg-body">
            <i className="mt-[7px] size-2 flex-none rounded-full bg-preview-dot shadow-[0_0_0_4px_var(--preview-dot-ring)]" aria-hidden="true" />
            <span>
              <strong className="font-medium text-fg">The next major is being designed in the open.</strong> It explores a smaller,
              framework-agnostic API built on plain functions, edited in Studio without your site running. v7 is what you build on today.
            </span>
          </p>
          <span className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <MdxLink className={`${textLink} text-link`} href="/next/">
              See the next major
              <Icon name="arrow-right" className={textLinkIcon} />
            </MdxLink>
            <MdxLink className={`${textLink} text-link`} href="/roadmap">
              Roadmap
              <Icon name="arrow-right" className={textLinkIcon} />
            </MdxLink>
          </span>
        </div>
      </div>
    </div>
  )
}

const noteLink = 'text-inherit underline decoration-1 underline-offset-2 rounded-[2px] transition-colors hover:text-fg'

export function V7FinalCta() {
  return (
    <div className="py-28 bg-bg text-center max-sm:py-20" role="group" aria-labelledby="final-title">
      <div className={`${container} flex flex-col items-center`}>
        <H2 id="final-title" className={`max-w-[760px] mx-auto ${reveal}`}>
          Start with one section. <Dim>Ship it today.</Dim>
        </H2>
        <div className={`${cta} justify-center ${reveal}`} style={d('120ms')}>
          <MdxLink className={btnPrimary} href="/v7/quickstart">
            Quickstart · TanStack
          </MdxLink>
          <MdxLink className={btnOutline} href="/v7/quickstart-nextjs">
            Quickstart · Next.js
          </MdxLink>
        </div>
        <p className={`mt-4 mx-auto max-w-[560px] text-13 leading-5 text-quiet ${reveal}`} style={d('120ms')}>
          Or read{' '}
          <MdxLink className={noteLink} href="/v7/architecture">
            how v7 works
          </MdxLink>
          , the{' '}
          <MdxLink className={noteLink} href="/v7/packages">
            packages and exports
          </MdxLink>
          , or{' '}
          <MdxLink className={noteLink} href="/v7/internals">
            what's under the hood
          </MdxLink>
          .
        </p>
      </div>
    </div>
  )
}
