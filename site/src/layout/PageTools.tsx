import { Icon } from '~/components/ui/Icon'
import { copyText, toast } from '~/src/lib/ui'
import { GITHUB_URL } from './Header'

async function copyPageLink() {
  const url = location.origin + location.pathname
  const ok = await copyText(url)
  toast(ok ? 'Link copied' : 'Copy the address bar to share this page.')
}

/** Compact "Copy link" / "Print" pills above the article (shown below 1200px, where the rail is hidden). */
export function PageTools() {
  return (
    <div className="page-tools">
      <button type="button" className="tool-btn" data-copy-link onClick={copyPageLink}>
        <Icon name="link" />
        <span>Copy link</span>
      </button>
      <button type="button" className="tool-btn" data-print onClick={() => window.print()}>
        <Icon name="printer" />
        <span>Print</span>
      </button>
    </div>
  )
}

/** The rail's page actions. */
export function PageActions() {
  return (
    <>
      <button type="button" className="rail-action" data-copy-link onClick={copyPageLink}>
        <Icon name="link" />
        Copy link to this page
      </button>
      <button type="button" className="rail-action" data-print onClick={() => window.print()}>
        <Icon name="printer" />
        Print or save as PDF
      </button>
      <a className="rail-action" href={GITHUB_URL} rel="noopener">
        <Icon name="github" />
        View on GitHub
      </a>
    </>
  )
}
