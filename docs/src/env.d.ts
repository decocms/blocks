/// <reference types="vite/client" />

declare module 'virtual:content-manifest' {
  import type { Manifest } from '~/build/manifest'
  const manifest: Manifest
  export default manifest
}

declare module '*.mdx' {
  import type { ComponentType } from 'react'
  import type { MDXComponents } from 'mdx/types'
  import type { DocHeading } from '~/build/rehype-docs'
  import type { PageFrontmatter } from '~/build/manifest'
  export const frontmatter: PageFrontmatter
  export const headings: DocHeading[]
  const MDXContent: ComponentType<{ components?: MDXComponents }>
  export default MDXContent
}
