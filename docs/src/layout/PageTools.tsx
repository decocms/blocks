import { Icon } from '~/components/ui/Icon'
import { copyText, toast } from '~/src/lib/ui'
import { GITHUB_URL } from './Header'

async function copyPageLink() {
  const url = location.origin + location.pathname
  const ok = await copyText(url)
  toast(ok ? 'Link copied' : 'Copy the address bar to share this page.')
}

/** A pill; icon-only below 560px. */
const toolButton =
  'inline-flex h-8 items-center gap-[7px] rounded-full border border-border bg-surface pr-3.5 pl-3 text-13 leading-4 font-normal text-muted-fg [transition:color_.3s_ease,border-color_.3s_ease,background-color_.3s_ease,scale_.25s_var(--ease-out-quart)] hover:border-border-strong hover:text-fg active:scale-[.97] max-sm:size-[34px] max-sm:justify-center max-sm:p-0'

/** Compact "Copy link" / "Print" pills above the article (shown below 1200px, where the rail is hidden). */
export function PageTools() {
  return (
    <div className="flex flex-none items-center gap-1.5 rail:hidden print:hidden">
      <button type="button" className={toolButton} data-copy-link onClick={copyPageLink}>
        <Icon name="link" className="size-3.5" />
        <span className="max-sm:sr-only">Copy link</span>
      </button>
      <button type="button" className={toolButton} data-print onClick={() => window.print()}>
        <Icon name="printer" className="size-3.5" />
        <span className="max-sm:sr-only">Print</span>
      </button>
    </div>
  )
}

const railAction =
  'inline-flex h-[30px] items-center gap-[9px] border-0 bg-transparent p-0 text-left text-13 leading-5 text-muted-fg no-underline transition-colors hover:text-fg'

/** The rail's page actions. */
export function PageActions() {
  return (
    <>
      <button type="button" className={railAction} data-copy-link onClick={copyPageLink}>
        <Icon name="link" className="size-3.5" />
        Copy link to this page
      </button>
      <button type="button" className={railAction} data-print onClick={() => window.print()}>
        <Icon name="printer" className="size-3.5" />
        Print or save as PDF
      </button>
      <a className={railAction} href={GITHUB_URL} rel="noopener">
        <Icon name="github" className="size-3.5" />
        View on GitHub
      </a>
    </>
  )
}
