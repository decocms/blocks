import { useState } from 'react'
import { Icon } from '~/components/ui/Icon'
import { MdxLink } from '~/components/mdx/MdxLink'
import { copyText, toast } from '~/src/lib/ui'
import { Journey } from './Journey'
import { btnPrimary, btnWhite, container, cta, d, enter } from './ui'

/**
 * The cobogó pattern behind a band (the <pattern>s #cb-lg/#cb-sm are defined once in index.tsx),
 * faded out towards the middle by a mask. `className` places it (top/height) and may swap the mask.
 */
export function Cobogo({ className = '' }: { className?: string }) {
  return (
    <svg className={`absolute inset-x-0 -z-1 w-full pointer-events-none ${className}`} aria-hidden="true" focusable="false">
      <rect className="max-md:hidden" width="100%" height="100%" fill="url(#cb-lg)" />
      <rect className="hidden max-md:inline" width="100%" height="100%" fill="url(#cb-sm)" />
    </svg>
  )
}

/** The default cobogó mask: pattern at both edges, clear in the middle. */
export const cobogoEdges =
  '[mask-image:linear-gradient(to_right,#000_0%,#000_17%,transparent_39%,transparent_61%,#000_83%,#000_100%)]'

const INSTALL = 'npm install @decocms/blocks'

/** The hero's "$ command" pill: copies `command`. A long one truncates on phones (the full text stays in data-copy and the label). */
export function InstallButton({ command = INSTALL }: { command?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="group h-12 inline-flex items-center gap-3 pl-5 pr-2.5 border-0 rounded-full bg-[rgba(255,255,255,.2)] text-white font-mono text-13.5 leading-5 max-w-full whitespace-nowrap transition-[background-color,scale] hover:bg-[rgba(255,255,255,.3)] active:scale-[.98] max-sm:w-full max-sm:justify-between max-sm:text-13"
      type="button"
      data-copy={command}
      aria-label={`Copy install command: ${command}`}
      onClick={async () => {
        const ok = await copyText(command)
        toast(ok ? `Copied: ${command}` : 'Select the text to copy it.')
        if (ok) {
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        }
      }}
    >
      <span className="text-brand" aria-hidden="true">
        $
      </span>
      <span className="min-w-0 overflow-hidden text-ellipsis max-sm:flex-1 max-sm:text-left">{command}</span>
      <span
        className="size-[30px] grid place-items-center rounded-full text-[rgba(255,255,255,.72)] group-hover:text-white group-hover:bg-[rgba(255,255,255,.1)]"
        aria-hidden="true"
      >
        <Icon name="copy" className={copied ? 'hidden' : 'size-3.5'} />
        <Icon name="check" className={copied ? 'size-3.5 block text-brand' : 'hidden'} />
      </span>
    </button>
  )
}

/** The hero band: forest gradient under the floating header, room for it on top. */
export const heroBand =
  'relative isolate overflow-hidden text-band-fg pt-[calc(var(--header-h)+112px)] pb-22 max-sm:pt-[calc(var(--header-h)+56px)] max-sm:pb-14 [background-image:radial-gradient(800px_600px_at_72%_20%,rgba(30,110,55,.45),transparent_60%),linear-gradient(162deg,#1A6030_0%,#0F4A22_48%,#082E14_100%)] [&_:where(:focus-visible)]:outline-brand'

/** The hero's h1 (white, fluid hero size). */
export const heroTitle = 'm-0 max-w-[800px] text-white text-hero leading-[1.14] font-normal tracking-display text-balance focus:outline-none'

export function Hero() {
  return (
    <div className={heroBand}>
      <Cobogo className={`top-[120px] h-[calc(100%-120px)] max-nav:top-[88px] max-nav:h-[calc(100%-88px)] ${cobogoEdges}`} />
      <div className={container}>
        <h1
          id="home-title"
          className={`${heroTitle} ${enter}`}
          style={d('60ms')}
        >
          Headless for developers.
          <br /> Editable for humans.
          <br /> <span className="text-[rgba(255,255,255,.52)]">Native for AI.</span>
        </h1>
        <p className={`mt-5 max-w-[560px] text-15 leading-[1.6] text-band-muted ${enter}`} style={d('120ms')}>
          Deco Blocks is the AI-native headless CMS. Developers write the functions, marketers edit the content and settings those
          functions use in Deco Studio, AI agents edit the same content as files, and every change lands in Git.
        </p>
        <div className={`${cta} ${enter}`} style={d('300ms')}>
          <MdxLink className={btnPrimary} href="/next/quickstart">
            Start building
          </MdxLink>
          <a className={btnWhite} href="#home-how">
            See how it works
          </a>
          <InstallButton />
        </div>
      </div>
      <div className={container}>
        <Journey />
      </div>
    </div>
  )
}
