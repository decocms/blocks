/**
 * The site's icon set (Lucide-style 24px strokes, from the former Python build, removed) and the stack-strip marks.
 *
 *   <Icon name="search" />            -> <svg class="icon i-search" …>  (16px by default via CSS)
 *   <Icon name="github" />            -> the GitHub mark (16px viewBox, filled)
 *   <Mark name="nextjs" />            -> <svg class="mark m-nextjs" …>  (filled, for the stack strip)
 *
 * Paths are trusted constants, so they're injected as markup.
 */
import type { SVGProps } from 'react'

export const ICON_PATHS = {
  "search": "<circle cx=\"11\" cy=\"11\" r=\"7\"/><path d=\"m20 20-3.5-3.5\"/>",
  "sun": "<circle cx=\"12\" cy=\"12\" r=\"4\"/><path d=\"M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41\"/>",
  "moon": "<path d=\"M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z\"/>",
  "menu": "<path d=\"M4 8h16M4 16h16\"/>",
  "x": "<path d=\"M18 6 6 18M6 6l12 12\"/>",
  "copy": "<rect width=\"13\" height=\"13\" x=\"9\" y=\"9\" rx=\"2\"/><path d=\"M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1\"/>",
  "check": "<path d=\"M20 6 9 17l-5-5\"/>",
  "chevron-right": "<path d=\"m9 18 6-6-6-6\"/>",
  "chevron-down": "<path d=\"m6 9 6 6 6-6\"/>",
  "arrow-right": "<path d=\"M5 12h14M13 6l6 6-6 6\"/>",
  "arrow-left": "<path d=\"M19 12H5M11 18l-6-6 6-6\"/>",
  "arrow-up": "<path d=\"M12 19V5M6 11l6-6 6 6\"/>",
  "file": "<path d=\"M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z\"/><path d=\"M14 2v6h6\"/>",
  "link": "<path d=\"M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71\"/><path d=\"M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71\"/>",
  "printer": "<path d=\"M6 9V2h12v7\"/><path d=\"M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2\"/><rect x=\"6\" y=\"14\" width=\"12\" height=\"8\" rx=\"1\"/>",
  "list": "<path d=\"M3 6h18M3 12h12M3 18h15\"/>",
  "git-commit": "<circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M3 12h6M15 12h6\"/>",
  "git-branch": "<path d=\"M6 3v12\"/><circle cx=\"18\" cy=\"6\" r=\"3\"/><circle cx=\"6\" cy=\"18\" r=\"3\"/><path d=\"M18 9a9 9 0 0 1-9 9\"/>",
  "pencil": "<path d=\"M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z\"/>",
  "play": "<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"m10 8.5 5 3.5-5 3.5Z\"/>",
  "box": "<path d=\"M21 8 12 3 3 8v8l9 5 9-5Z\"/><path d=\"m3 8 9 5 9-5M12 13v8\"/>",
  "sliders": "<path d=\"M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1.5 14h5M9.5 8h5M17.5 16h5\"/>",
  "globe": "<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M3 12h18M12 3a14 14 0 0 1 3.6 9A14 14 0 0 1 12 21a14 14 0 0 1-3.6-9A14 14 0 0 1 12 3Z\"/>",
  "book": "<path d=\"M3 4.5h6a3 3 0 0 1 3 3V20a2.5 2.5 0 0 0-2.5-2.5H3ZM21 4.5h-6a3 3 0 0 0-3 3V20a2.5 2.5 0 0 1 2.5-2.5H21Z\"/>",
  "layers": "<path d=\"m12 2.5 9.5 5-9.5 5-9.5-5Z\"/><path d=\"m2.5 12 9.5 5 9.5-5M2.5 16.5l9.5 5 9.5-5\"/>",
  "server": "<rect x=\"3\" y=\"3\" width=\"18\" height=\"7\" rx=\"2\"/><rect x=\"3\" y=\"14\" width=\"18\" height=\"7\" rx=\"2\"/><path d=\"M7 6.5h.01M7 17.5h.01\"/>",
  "cpu": "<rect x=\"5\" y=\"5\" width=\"14\" height=\"14\" rx=\"2\"/><path d=\"M9.5 9.5h5v5h-5zM9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3\"/>",
  "hash": "<path d=\"M4 9h16M4 15h16M10 3 8 21M16 3l-2 18\"/>",
  "code": "<path d=\"m16 18 6-6-6-6M8 6l-6 6 6 6\"/>",
  "terminal": "<path d=\"m4 17 6-5-6-5M12 19h8\"/>",
  "sparkle": "<path d=\"M12 3.5 13.9 10 20.5 12l-6.6 2L12 20.5 10.1 14 3.5 12l6.6-2Z\"/>",
  "eye": "<path d=\"M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/>",
  "lock": "<rect x=\"4\" y=\"11\" width=\"16\" height=\"10\" rx=\"2\"/><path d=\"M8 11V7a4 4 0 0 1 8 0v4\"/>",
  "zap": "<path d=\"M13 2 4 14h7l-1 8 9-12h-7l1-8Z\"/>",
  "corner": "<path d=\"m9 10-5 5 5 5\"/><path d=\"M20 4v7a4 4 0 0 1-4 4H4\"/>",
  "cloud": "<path d=\"M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z\"/>",
  "smartphone": "<rect width=\"14\" height=\"20\" x=\"5\" y=\"2\" rx=\"2\"/><path d=\"M12 18h.01\"/>",
  "plus": "<path d=\"M12 5v14M5 12h14\"/>"
} as const

export const MARK_PATHS = {
  "nextjs": "<path d=\"M18.665 21.978C16.758 23.255 14.465 24 12 24 5.377 24 0 18.623 0 12S5.377 0 12 0s12 5.377 12 12c0 3.583-1.574 6.801-4.067 9.001L9.219 7.2H7.2v9.596h1.615V9.251l9.85 12.727Zm-3.332-8.533 1.6 2.061V7.2h-1.6v6.245Z\"/>",
  "git": "<path d=\"M23.546 10.93L13.067.452c-.604-.603-1.582-.603-2.188 0L8.708 2.627l2.76 2.76c.645-.215 1.379-.07 1.889.441.516.515.658 1.258.438 1.9l2.658 2.66c.645-.223 1.387-.078 1.9.435.721.72.721 1.884 0 2.604-.719.719-1.881.719-2.6 0-.539-.541-.674-1.337-.404-1.996L12.86 8.955v6.525c.176.086.342.203.488.348.713.721.713 1.883 0 2.6-.719.721-1.889.721-2.609 0-.719-.719-.719-1.879 0-2.598.182-.18.387-.316.605-.406V8.835c-.217-.091-.424-.222-.6-.401-.545-.545-.676-1.342-.396-2.009L7.636 3.7.45 10.881c-.6.605-.6 1.584 0 2.189l10.48 10.477c.604.604 1.582.604 2.186 0l10.43-10.43c.605-.603.605-1.582 0-2.187\"/>",
  "cloudflare": "<circle cx=\"6.6\" cy=\"15\" r=\"5\"/><circle cx=\"13.2\" cy=\"10.6\" r=\"7\"/><circle cx=\"19\" cy=\"15.5\" r=\"4.5\"/><rect x=\"6.6\" y=\"14\" width=\"12.4\" height=\"6\"/>",
  "tanstack": "<path d=\"M12 1.8 22.2 7 12 12.2 1.8 7Z\"/><path d=\"M1.8 11.1 12 16.3l10.2-5.2v2.6L12 18.9 1.8 13.7Z\"/><path d=\"M1.8 16.2 12 21.4l10.2-5.2v2.6L12 24 1.8 18.8Z\"/>",
  "react": "<circle cx=\"12\" cy=\"12\" r=\"2.2\"/><g fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"><ellipse cx=\"12\" cy=\"12\" rx=\"10.5\" ry=\"4.1\"/><ellipse cx=\"12\" cy=\"12\" rx=\"10.5\" ry=\"4.1\" transform=\"rotate(60 12 12)\"/><ellipse cx=\"12\" cy=\"12\" rx=\"10.5\" ry=\"4.1\" transform=\"rotate(120 12 12)\"/></g>",
  "node": "<path d=\"M12 .8 21.7 6.4v11.2L12 23.2 2.3 17.6V6.4Z\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linejoin=\"round\"/>"
} as const

const GITHUB_PATH = "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"

export type IconName = keyof typeof ICON_PATHS | 'github'
export type MarkName = keyof typeof MARK_PATHS

type SvgProps = Omit<SVGProps<SVGSVGElement>, 'name'>

export function Icon({ name, strokeWidth = 1.75, className, ...rest }: { name: IconName; strokeWidth?: number } & SvgProps) {
  const cls = `icon i-${name}${className ? ` ${className}` : ''}`
  if (name === 'github')
    return (
      <svg className={cls} viewBox="0 0 16 16" aria-hidden="true" focusable="false" {...rest}>
        <path fill="currentColor" d={GITHUB_PATH} />
      </svg>
    )
  return (
    <svg
      className={cls}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: ICON_PATHS[name] }}
      {...rest}
    />
  )
}

export function Mark({ name, className, ...rest }: { name: MarkName } & SvgProps) {
  return (
    <svg
      className={`mark m-${name}${className ? ` ${className}` : ''}`}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: MARK_PATHS[name] }}
      {...rest}
    />
  )
}
