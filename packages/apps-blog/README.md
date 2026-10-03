# `@decocms/apps-blog` (v7 only)

This package is the v7 blog app. It has no next-major surface: the next major
ships no blog package, and nothing new is added here.

In the next major a blog is content plus code the site owns:

| v7 (this package) | Next major |
|---|---|
| `BlogPost`, `Author`, `Category` and the other types | The blog template's own types. |
| `getRecordsByPath` (reads the global decofile) | `client.list("post")`, `client.list("author")`, `client.list("category")` over saved blocks, with `where` / `sort` / `limit`. It reads the request's revision, so drafts work. |
| `handlePosts` (filter, sort, paginate) | `client.list` options, or the template's own helper. |
| `createBlogLoaders` and the `blog/loaders/*.ts` keys | Data-only blocks (`const post = (props: Post) => props`) in the template's block map. The `blog/loaders/*.ts` names stored by v7 content are registered as aliases, or as converter functions where the old shape differs, and loaders the site used are vendored under their old keys by the migration. |
| `blog/sections/blocks/*.tsx` (post body blocks) | Data-only blocks plus a renderer in the template. |
| `sections/Seo/SeoBlogPost*.tsx` | SEO helpers in the template. |
| Ratings, reviews and view-count actions, and the `loaders/extensions/*` ratings/reviews loaders | Site code (see *Migrating from v7*, loaders and actions). |

See the next-major docs: *Data-only blocks* (schema), `client.list` (API
reference), *Pages and routing*, and *Migrating from v7*.

Port notes for the v7 code are in [`src/README.md`](./src/README.md).
