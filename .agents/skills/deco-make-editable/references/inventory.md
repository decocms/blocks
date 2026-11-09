# Inventory: what is content, what is interface

Do this before writing any block. It decides the size of every PR after it.

## Find the candidates

Search every component for:

- literal text in JSX (headings, paragraphs, button labels);
- arrays of links or cards (`const LINKS = [...]`, `const FEATURES = [...]`);
- copy objects (`COPY = { en: {...}, pt: {...} }`, `t.title`, `label`/`labelPt`);
- image URLs and `alt` texts written in code;
- page composition: a route component that renders `<Hero/><Features/><Faq/>`
  in a fixed order.

A quick start:

```sh
rg -n -g '*.tsx' '>[A-Z][a-z]+ [a-z]+' src/          # literal text in JSX
rg -n 'const [A-Z_]+ = \[' src/                       # hardcoded lists
rg -n '(en|pt|es):\s*\{' src/                         # per-language copy objects
```

## Classify each one

| Goes to the CMS (content) | Stays in code (interface or logic) |
|---|---|
| Headings, intros, card texts, calls to action and their links | `aria-label`s, "Skip to content", "Open menu" |
| Menus, footers, banners | Button states ("Copy link" then "Link copied") |
| Lists editors will reorder (cards, steps, FAQs) | Text tied to logic: status labels driven by data, version pickers |
| Which sections a page has, and their order | Navigation built by code from several sources |
| Images and their `alt` text | Error messages from forms and APIs |

Rule of thumb: if changing it needs a code release anyway (a new route, a new
version), it stays in code. Putting it in the CMS only adds a second place to
forget.

Interface text that stays in code still needs a translation when the site has
two languages. Keep it in a small dictionary in code, not in a block.

## Record it

Write the inventory down before converting. One row per area:

| Area | Files | Fields | Shape | Priority |
|---|---|---|---|---|
| Header menu | `src/components/Header.tsx` | links (label, href) | global block | 1 |
| Home | `src/routes/index.tsx`, `src/components/home/*` | hero, guides, CTA | composed page | 2 |
| Landing pages | `src/routes/solutions/*` | hero, features | composed page | 3 |
| Articles | `content/*.mdx` | title, body, date | collection | 4 |

The shapes are explained in [content-shapes.md](./content-shapes.md).

Convert by priority: the most viewed pages first. They pay back the work
soonest, and the parity checks on them catch the most.

## Size of a PR

One area per PR. A PR that converts the header, the home and two landings at
once cannot be checked for parity in a review: any pixel difference has four
possible causes.

Each PR carries:

- the block types added to the block map and the regenerated
  `.deco/schema.gen.json`;
- the seeded `.deco/blocks` files, or the draft name they were pushed to (see
  [seeding-content.md](./seeding-content.md));
- the parity evidence (see [pixel-parity.md](./pixel-parity.md)).

## Clean up on the way

- Delete dead components you find. They cost nothing in Studio on v8 (only the
  block map is listed), but they confuse the next person who greps for a text.
- When you move a component to a new file, say so in the PR description: open
  PRs that import the old path will break.
- Element ids built from a list index (`card-0`) instead of a slug change the
  HTML when an editor reorders the list. Check that no CSS or anchor link
  targets them.
