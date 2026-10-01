import { useState, type CSSProperties } from 'react'
import { Icon } from '~/components/ui/Icon'
import { MdxLink } from '~/components/mdx/MdxLink'
import { copyText, toast } from '~/src/lib/ui'
import { Journey } from './Journey'

/** `style={d('120ms')}`: the entrance/reveal delay (`--d`) the old markup set inline. */
export const d = (ms: string) => ({ '--d': ms }) as CSSProperties

/** The cobogó pattern behind a band (patterns defined once by <CobogoDefs/>). */
export function Cobogo({ className = '' }: { className?: string }) {
  return (
    <svg className={`cobogo${className ? ` ${className}` : ''}`} aria-hidden="true" focusable="false">
      <rect className="cb-lg" width="100%" height="100%" fill="url(#cb-lg)" />
      <rect className="cb-sm" width="100%" height="100%" fill="url(#cb-sm)" />
    </svg>
  )
}

const INSTALL = 'npm install @decocms/blocks'

function InstallButton() {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className={`install${copied ? ' copied' : ''}`}
      type="button"
      data-copy={INSTALL}
      aria-label={`Copy install command: ${INSTALL}`}
      onClick={async () => {
        const ok = await copyText(INSTALL)
        toast(ok ? `Copied: ${INSTALL}` : 'Select the text to copy it.')
        if (ok) {
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        }
      }}
    >
      <span className="prompt" aria-hidden="true">
        $
      </span>
      <span>{INSTALL}</span>
      <span className="install-icon" aria-hidden="true">
        <Icon name="copy" />
        <Icon name="check" />
      </span>
    </button>
  )
}

export function Hero() {
  return (
    <div className="hero band">
      <Cobogo />
      <div className="container hero-inner">
        <h1 id="home-title" className="enter" style={d('60ms')}>
          Headless for developers.
          <br /> Editable for humans.
          <br /> <span className="hl">Native for AI.</span>
        </h1>
        <p className="lede enter" style={d('120ms')}>
          Deco Blocks is the AI-native headless CMS. Developers write the functions, marketers edit the content and settings those
          functions use in Deco Studio's visual editor, AI agents edit the same content as files, and every change lands in Git.
        </p>
        <div className="cta enter" style={d('300ms')}>
          <MdxLink className="btn btn-primary" href="/next/quickstart">
            Start building
          </MdxLink>
          <a className="btn btn-white" href="#home-how">
            See how it works
          </a>
          <InstallButton />
        </div>
      </div>
      <div className="container">
        <Journey />
      </div>
    </div>
  )
}
