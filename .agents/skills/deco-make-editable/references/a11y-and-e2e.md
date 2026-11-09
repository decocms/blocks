# Accessibility and functional checks

Pixel parity proves a section looks right with today's content. These checks
prove it works, for every visitor, and keeps working when editors change the
content.

Deeper checklists live in other skills; this file lists what a conversion or a
Figma build must not skip:

- `deco-go-live`: a QA checklist built from the site's blocks and routes.
- `ecommerce-qa` (decocms/skills): the storefront flows (search, product,
  cart, checkout).
- `deco-images-media` and `deco-storefront-performance`: images, LCP, CLS,
  heavy HTML.

## Content robustness

Editors will do things the design never showed. For each section, try:

- every optional field empty: no empty heading tag, no dangling separator, no
  broken layout;
- a text three times longer than the design's, and a one-word one;
- a list with zero items, one item, and more items than the design shows;
- a section removed, and the same section added twice to one page;
- an image with a different aspect ratio than the design's.

A section that renders nothing when its main content is empty is better than
one that renders an empty box. A section added twice must not reuse an `id`
(two `id="faq"` break anchors and `aria-controls`).

## Accessibility

- **Headings:** one `h1` per page, then `h2` and `h3` in order. A section's
  heading level must not depend on where an editor puts it: when a section can
  be first on a page (and become the `h1`), give it a prop for the level or
  keep the `h1` in a section that only goes first.
- **Images:** every content image has `alt` text, and the `alt` is a field
  next to the image in the form. Decorative images have `alt=""`.
- **Links and buttons:** every icon-only control has an accessible name
  (`aria-label`, kept in code). Links that open a new tab say so to screen
  readers.
- **Contrast:** WCAG AA, 4.5:1 for normal text, 3:1 for large text and UI
  parts. When editors choose colors or put text over an image they choose,
  contrast is their choice: add an overlay or a text color option to the
  section instead of trusting each image.
- **Keyboard:** every interactive element is reachable with Tab, shows a
  visible focus ring, and works with Enter or Space. Menus and drawers close
  with Escape and return focus to the button that opened them.
- **Language:** `<html lang>` matches the page's language on a two-language
  site (`DecoDocument` takes a `lang` prop on TanStack Start).
- A skip link to the main content, when the header has many links.

Run an automated pass (axe or Lighthouse) on each converted page as a floor,
not as proof.

## Functional checks

Walk each converted page on desktop (1440px) and mobile (375px or 390px).

**Header and navigation**

- The logo links home. Every menu link goes where its `href` says, with the
  locale prefix on secondary-language pages.
- Dropdowns or mega menus open on hover and on keyboard focus.
- Mobile: the menu button opens the drawer, nested items expand and collapse,
  the drawer closes on navigation and on a backdrop tap.
- A sticky header does not cover anchored headings (`scroll-margin-top`).

**Content sections**

- Calls to action link to the right page. External links open in a new tab.
- Carousels: arrows and dots work, swipe works on mobile, autoplay stops on
  hover and focus.
- Accordions and tabs work with the keyboard.
- Forms (newsletter, contact) submit, show success and error states, and
  keep their messages in code, not in a block.

**Footer**

- Every link column renders and links work. Social and payment icons render.
- Mobile: columns stack or collapse as designed.

**Mobile**

- Touch targets are at least 44×44px.
- No horizontal scroll at 375px.
- Body text is at least 16px.
- Fixed or sticky bars do not hide content.

## Performance, briefly

- The page's LCP image uses `preload`; every other image loads lazily.
- Every image has `width` and `height`, so nothing shifts while it loads.
- Deferring sections far below the fold (the built-in `lazy` block, loading
  skeletons) is covered in `deco-site-authoring`.
- Compare the HTML size of a converted page with `main`. Content from a block
  should not make a page heavier than the hardcoded version.

## Automate what you repeat

When a check runs on every PR (menu links, the mobile drawer, the CTA
targets), write it as a Playwright test against the dev server. Keep the tests
on behavior and roles (`getByRole("navigation")`, `getByRole("button", { name:
"Open menu" })` for interface text kept in code), not on CSS classes or
positions, so an editor reordering sections or rewording a heading does not
break them.
