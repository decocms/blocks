/**
 * Documentation versions. Each one is a folder under content/ and a URL prefix (/next/…, /v7/…).
 * The header's version select lists them in this order. Adding a version = adding an entry here
 * and a content/<id>/ folder (with at least an index.mdx).
 */
export interface DocsVersion {
  /** URL segment and content folder name. */
  id: string
  /** What the version select shows. */
  label: string
  /** Shown as a note under the select's label for screen readers and as its title. */
  description: string
}

export const VERSIONS: readonly DocsVersion[] = [
  { id: 'next', label: 'Next major', description: 'The proposed API for the next major version (unreleased)' },
  { id: 'v7', label: 'v7', description: 'The current released version' },
]

/** The version the Home page, the header tabs and "Get started" point at. */
export const DEFAULT_VERSION = 'next'

export const isVersion = (id: string): boolean => VERSIONS.some((v) => v.id === id)
