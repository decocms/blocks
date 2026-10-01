/**
 * The landing's bands under the hero: stack strip, "Every change is a commit" cards, the
 * stability band, publishing timeline, and "Small on purpose". (The stepper is Stepper.tsx; the
 * final CTA and footer are Footer.tsx.) Classes are the old landing's (legacy.css).
 */
import type { CSSProperties } from 'react'
import { Icon, Mark, type MarkName } from '~/components/ui/Icon'
import { MdxLink } from '~/components/mdx/MdxLink'
import { Cobogo, d } from './Hero'

const Dots = ({ hidden }: { hidden?: boolean }) => (
  <span className="win-dots" aria-hidden={hidden ? 'true' : undefined}>
    <i />
    <i />
    <i />
  </span>
)

const STACK: [MarkName, string][] = [
  ['nextjs', 'Next.js'],
  ['tanstack', 'TanStack Start'],
  ['cloudflare', 'Cloudflare Workers'],
  ['react', 'React Native'],
  ['node', 'Node.js'],
  ['git', 'Any Git repo'],
]

export function StackStrip() {
  return (
    <div className="lsec stack-sec">
      <div className="container">
        <p className="kicker is-center reveal">Runs on your stack</p>
        <ul className="stack reveal" style={d('80ms')} aria-label="Runtimes">
          {STACK.map(([mark, label]) => (
            <li key={mark}>
              <Mark name={mark} />
              {label}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

export function ContentModel() {
  return (
    <div className="lsec">
      <div className="container section">
        <div className="section-head">
          <p className="kicker reveal">One content model</p>
          <h2 className="reveal" style={d('60ms')}>
            Every change is a commit, <span className="dim">whoever makes it.</span>
          </h2>
          <p className="section-lede reveal" style={d('120ms')}>
            Launch a landing page at <code>/summer-sale</code>, schedule a campaign banner, ramp an experiment to 25%: all from a form, all
            reviewable, none of it a code change.
          </p>
        </div>
        <div className="contract-list reveal" style={d('160ms')}>
          <div className="contract-item">
            <div className="ci-visual ci-code win" aria-hidden="true" data-pagefind-ignore="">
              <div className="win-bar">
                <Dots />
                <span className="win-title">blocks.ts</span>
              </div>
              <pre className="mini-pre">
                <code>
                  <span className="sy-k">export default</span>
                  {' {\n  '}
                  <span className="sy-p">experiments</span>
                  {',  '}
                  <span className="sy-c">// returns A/B flags</span>
                  {'\n  '}
                  <span className="sy-p">hero</span>
                  {',         '}
                  <span className="sy-c">// returns JSX</span>
                  {'\n  '}
                  <span className="sy-p">seo</span>
                  {',          '}
                  <span className="sy-c">// returns page metadata</span>
                  {'\n} '}
                  <span className="sy-k">satisfies</span> <span className="sy-t">Blocks</span>;
                </code>
              </pre>
            </div>
            <span className="num">01</span>
            <h3>Headless for developers</h3>
            <p>
              Write a function, type its inputs, and add it to your block map. Content can now call it. Deco Blocks stays out of your stack:
              no database and no content API to run, just JSON files in your repository and a small SDK that works with Next.js, TanStack
              Start, or any JavaScript server.
            </p>
          </div>
          <div className="contract-item">
            <div className="ci-visual ci-form win" aria-hidden="true" data-pagefind-ignore="">
              <div className="win-bar">
                <Dots />
                <span className="win-title">Studio — Summer campaign</span>
              </div>
              <div className="mf-body">
                <div className="mf-row">
                  <span className="mf-label">Name</span>
                  <span className="mf-input">Summer campaign</span>
                </div>
                <div className="mf-row">
                  <span className="mf-label">Path</span>
                  <span className="mf-input mono is-focus">
                    /summer-sale
                    <span className="caret" />
                  </span>
                </div>
                <div className="mf-row">
                  <span className="mf-label">Blocks</span>
                  <span className="mf-chips">
                    <span>hero</span>
                    <span>product</span>
                    <span className="add">+ Add</span>
                  </span>
                </div>
              </div>
            </div>
            <span className="num">02</span>
            <h3>Editable for humans</h3>
            <p>
              Deco Studio, the visual editor in the hosted Deco CMS, turns your types into forms and live previews. Marketers and editors
              change pages, campaigns, and settings without a developer, and every change is a commit you can review and roll back.
            </p>
          </div>
          <div className="contract-item">
            <div className="ci-visual ci-agent" aria-hidden="true" data-pagefind-ignore="">
              <div className="bubble">
                <span className="bubble-who">You</span>Ramp the new checkout to 25%
              </div>
              <div className="agent-edit">
                <div className="ae-file">
                  <Icon name="sparkle" />
                  <span>Edited .deco/blocks/Experiments.json</span>
                </div>
                <code className="ae-line del">-  "newCheckout": 10,</code>
                <code className="ae-line add">+  "newCheckout": 25,</code>
                <div className="ae-ok">
                  <Icon name="check" />
                  <span>
                    Valid against <b>.deco/schema.json</b>
                  </span>
                </div>
              </div>
            </div>
            <span className="num">03</span>
            <h3>Native for AI</h3>
            <p>
              Content is typed JSON in Git, so coding agents read, edit, and validate it with the tools they already have. Their edits arrive
              as ordinary commits your team reviews like anyone else's, and the same types that build the editor keep them honest.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

export function Stability() {
  return (
    <div className="lsec prod-sec">
      <div className="container">
        <div className="prod rely">
          <Cobogo className="cobogo-right" />
          <div className="section-head">
            <p className="kicker reveal">Built for stability</p>
            <h2 className="reveal" style={d('60ms')}>
              Your site ships with its content. <span className="dim">Nothing stands between it and your visitors.</span>
            </h2>
            <p className="section-lede reveal" style={d('120ms')}>
              Your pages, banners and settings are files in your own repository, and every deploy carries them alongside the code. Your site
              always has the content it needs at hand, so a page never waits on a content server.
            </p>
          </div>
          <div className="rely-grid">
            <div className="status win reveal" style={d('160ms')} role="group" aria-labelledby="status-title" data-pagefind-ignore="">
              <div className="win-bar">
                <Dots hidden />
                <span className="win-title" id="status-title">
                  store.example.com — status
                </span>
              </div>
              <div className="status-body">
                <div className="pkg">
                  <p className="pkg-label">Every deploy ships</p>
                  <div className="pkg-tiles">
                    <div className="pkg-tile">
                      <Icon name="code" />
                      <strong>Your code</strong>
                      <small>Design, features</small>
                    </div>
                    <span className="pkg-plus" aria-hidden="true">
                      +
                    </span>
                    <div className="pkg-tile is-content">
                      <Icon name="file" />
                      <strong>Your content</strong>
                      <small>Pages, banners, settings</small>
                    </div>
                  </div>
                  <p className="pkg-cap">Packed together, tested together.</p>
                </div>
                <ul className="st-rows" role="list">
                  <li>
                    <span className="st-k">Your site</span>
                    <span className="st-pill is-serving">
                      <i aria-hidden="true" />
                      Online
                    </span>
                  </li>
                  <li>
                    <span className="st-k">Content</span>
                    <span className="st-pill is-ok">
                      <Icon name="check" />
                      Inside this deploy
                    </span>
                  </li>
                  <li>
                    <span className="st-k">Page loads</span>
                    <span className="st-pill is-ok">
                      <Icon name="check" />
                      No extra round trip
                    </span>
                  </li>
                </ul>
              </div>
            </div>
            <ul className="rely-points reveal" style={d('200ms')} role="list">
              <Point title="No content servers to run">No content database or content server to host, scale or keep online.</Point>
              <Point title="Fast on every page">
                Every page is built from content your site already holds, so it loads as fast as your own code.
              </Point>
              <Point title="Stable by design">
                Your site depends on no other service to show its content. Every deploy carries a tested copy of it as the fallback, so what
                visitors see is always a version you shipped or published.
              </Point>
            </ul>
            <MdxLink className="text-link dev-link reveal" href="/next/releases">
              <span className="dev-k">For developers:</span> how content{' '}
              <span className="dl-end">
                loads
                <Icon name="arrow-right" />
              </span>
            </MdxLink>
          </div>
        </div>
      </div>
    </div>
  )
}

function Point({ title, children }: { title: string; children: string }) {
  return (
    <li>
      <Icon name="check" />
      <span className="rp-body">
        <strong>{title}</strong>
        <span>{children}</span>
      </span>
    </li>
  )
}

export function Publishing() {
  return (
    <div className="lsec pub-sec">
      <div className="container section">
        <div className="section-head">
          <p className="kicker reveal">Hosted Deco CMS · optional</p>
          <h2 className="reveal" style={d('60ms')}>
            Publish in seconds, <span className="dim">not on the next deploy.</span>
          </h2>
          <p className="section-lede reveal" style={d('120ms')}>
            The hosted Deco CMS adds Deco Studio, the visual editor, and publishing without a redeploy: each change reaches every visitor in
            seconds, and editors preview drafts on your real pages first. Without it, developers and agents edit the files, and content goes
            live with your next deploy.
          </p>
        </div>
        <div className="pub win reveal" style={d('160ms')} aria-hidden="true" data-pagefind-ignore="">
          <div className="win-bar">
            <Dots />
            <span className="win-title">Publishing a change — store.example.com</span>
          </div>
          <div className="pub-body">
            <div className="pub-lane is-base">
              <p className="pub-label">
                <b>Without it</b>
                <span className="pub-sep">·</span>
                <span className="pub-sub">content ships with your next deploy</span>
              </p>
              <ol className="pub-steps">
                <li style={c(1)}>Edit</li>
                <li style={c(3)} className="is-far">
                  Commit
                </li>
                <li style={c(4)}>Build</li>
                <li style={c(5)}>Deploy</li>
                <li style={c(6)} className="is-end">
                  Live
                </li>
              </ol>
              <div className="pub-notes">
                <span className="pub-bracket">code release</span>
                <span className="pub-cap">at your next deploy</span>
              </div>
            </div>
            <div className="pub-lane is-hosted">
              <p className="pub-label">
                <b>With the hosted Deco CMS</b>
                <span className="pub-sep">·</span>
                <span className="pub-sub">each publish is a commit</span>
              </p>
              <ol className="pub-steps">
                <li style={c(1)}>Edit</li>
                <li style={c(2)} className="has-badge">
                  Preview
                  <span className="pub-badge">
                    <i />
                    Previewing a draft
                  </span>
                </li>
                <li style={c(3)}>Publish</li>
                <li style={c(4)} className="is-skip">
                  Build
                </li>
                <li style={c(5)} className="is-skip">
                  Deploy
                </li>
                <li className="is-skip is-merged">No build · no deploy</li>
                <li style={c(6)} className="is-live">
                  Live everywhere
                </li>
              </ol>
              <div className="pub-notes">
                <span className="pub-bracket is-skip">not needed</span>
                <span className="pub-cap is-live">in seconds</span>
              </div>
            </div>
          </div>
        </div>
        <ul className="pub-points reveal" style={d('200ms')} role="list">
          <li>
            <strong>Not tied to code releases</strong>
            <span>
              Content needs no build and no deploy, so editors publish when a campaign is ready, not when the next code release goes out.
            </span>
          </li>
          <li>
            <strong>Preview on the real site</strong>
            <span>Editors open drafts on your actual pages before anything goes live, and only people Studio lets in can see them.</span>
          </li>
          <li>
            <strong>Undo any change</strong>
            <span>Every publish is saved in your repository's history, with who changed what and when, so going back is one step.</span>
          </li>
        </ul>
        <MdxLink className="text-link dev-link reveal" href="/next/releases">
          <span className="dev-k">For developers:</span> publishing and{' '}
          <span className="dl-end">
            releases
            <Icon name="arrow-right" />
          </span>
        </MdxLink>
      </div>
    </div>
  )
}

const c = (n: number) => ({ '--c': n }) as CSSProperties

const HOOD_LINKS: { href: string; title: string; text: string; read: string }[] = [
  {
    href: '/next/model',
    title: 'Nothing to export',
    text: 'Content is plain, documented files you already hold: open them in any editor, search them, or generate them with a script.',
    read: 'Read: How a page is built from content',
  },
  {
    href: '/next/walkthrough',
    title: 'Small enough to read',
    text: 'Content is plain files and features are ordinary code, so any developer or AI agent can follow how a page is made, with the tools they already use.',
    read: 'Read: How resolution works',
  },
  {
    href: '/next/content',
    title: 'Swap any piece',
    text: 'Where content comes from is one option you can change: files in your repository, the hosted Deco CMS, or your own storage, such as a key-value store or a database. Nothing else in your site changes.',
    read: 'Read: Content & loaders',
  },
  {
    href: '/next/decisions',
    title: 'Openly documented',
    text: 'How each part works, and why it was built that way, is written down in these docs, and the source is public on GitHub.',
    read: 'Read: Design decisions',
  },
]

const OWN: [string, string, 'yours' | 'opt'][] = [
  ['Content', 'Your Git repository', 'yours'],
  ['Code', 'Your Git repository', 'yours'],
  ['Hosting', 'Any JavaScript runtime you choose: Node, Cloudflare Workers, Deno or Bun', 'yours'],
  ['Visual editor & publishing without a redeploy', 'Hosted Deco CMS', 'opt'],
]

export function SmallOnPurpose() {
  return (
    <div className="lsec hood-sec">
      <div className="container section hood-grid">
        <div className="hood-left">
          <p className="kicker reveal">Yours to keep</p>
          <h2 className="reveal" style={d('60ms')}>
            Small on purpose. <span className="dim">Nothing hidden.</span>
          </h2>
          <p className="section-lede reveal" style={d('120ms')}>
            Deco Blocks is a small library and a folder of files in your own repository, not a platform you move into. You can read how the
            library works, swap any piece of it, and keep all of your content whatever you decide next.
          </p>
          <div className="own reveal" style={d('160ms')}>
            <p className="own-title" id="own-title">
              Where your site lives
            </p>
            <dl className="own-map" aria-labelledby="own-title">
              {OWN.map(([what, where, tag]) => (
                <div className="own-row" key={what}>
                  <dt>{what}</dt>
                  <dd className="own-where">{where}</dd>
                  <dd className="own-tag">
                    <span className={`tag tag-${tag}`}>{tag === 'yours' ? 'Yours' : 'Optional'}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
        <div className="hood-right">
          <div className="hood-links reveal" style={d('120ms')}>
            {HOOD_LINKS.map((l) => (
              <MdxLink href={l.href} key={l.href}>
                <span className="hl-body">
                  <strong>{l.title}</strong>
                  <span>{l.text}</span>
                  <span className="hl-k">{l.read}</span>
                </span>
                <Icon name="arrow-right" />
              </MdxLink>
            ))}
          </div>
          <MdxLink className="text-link hood-more reveal" href="/next/internals">
            How it works as a whole
            <Icon name="arrow-right" />
          </MdxLink>
        </div>
      </div>
    </div>
  )
}
