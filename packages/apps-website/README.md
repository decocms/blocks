# `@decocms/apps-website` (v7 only)

This package is the v7 website app. It has no next-major surface: the next
major ships no website package, and nothing new is added here.

Website features move to the platform templates (starter sites you copy and
own) or to built-ins:

| v7 (this package) | Next major |
|---|---|
| SEO components and sections (`Seo`, `SeoV2`) | SEO helpers in the platform templates. |
| `Analytics` section (Google Tag Manager, GA4) | A tag manager block in the platform template, owned by the site. |
| `Stats`, `OneDollarStats` | The built-in `analytics` block. |
| `website/loaders/secret.ts` | The built-in `secret` block; the migration re-encrypts each v7 secret. |
| `website/pages/Page.tsx`, `website/flags/multivariate.ts` | The built-in `page` and `multivariate`, through the CLI alias table. |
| Matchers | The built-in `always`, `never` and `date` matchers; others are site code. |
| Fonts, theme, video, environment loaders, sitemaps, redirect logic | Platform templates and site code. |

See the next-major docs: *Calling APIs* (what is not in a client),
*Built-in blocks* and *Migrating from v7*.
