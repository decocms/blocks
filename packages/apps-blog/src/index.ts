/**
 * Public API for the blog app.
 *
 * Subpath imports cover the rest of the surface:
 * `@decocms/apps-blog/loaders/*`, `/actions/*`, `/sections/*`,
 * `/sections/Seo/*`, `/sections/blocks/*`, `/utils/*`, `/core/*`,
 * `/mod`, `/registry`, `/types`.
 */

export { type BlogConfig, type BlogSeoDefaults, configureBlog, getBlogConfig } from "./client";
export {
  type BlogRecordsAdapter,
  type CreateReviewInput,
  getBlogRecordsAdapter,
  type ListReviewsOptions,
  setBlogRecordsAdapter,
  type UpdateReviewInput,
  type UpsertRatingInput,
} from "./core/blogRecords";
export { getRecordsByPath } from "./core/records";
export {
  createBlogLoaders,
  /** @deprecated Use `createBlogLoaders` instead. */
  createBlogLoaders as createBlogCommerceLoaders,
} from "./loaderMap";
export { configure, handlers } from "./mod";
// Types
export type {
  AggregateRating,
  Author,
  Banner,
  BannerItem,
  BlogPost,
  BlogPostListingPage,
  BlogPostPage,
  Category,
  ExtraProps,
  Ignore,
  ImageCarousel,
  InteractionCounter,
  PageInfo,
  PostStatus,
  Publisher,
  Rating,
  Review,
  Section,
  Seo,
  SortBy,
  ViewFromDatabase,
} from "./types";
// Publication-status predicates — runtime exports, not just types: a site that
// renders its own listing must apply the same liveness rule the loaders do.
export { isLivePost, isPublishedStatus } from "./types";
export { blocksToSections } from "./utils/blocksToSections";
export { dateToTime, scheduledTime } from "./utils/date";
export { hardSanitize } from "./utils/hardSanitize";
export { toBlogPosting, toBreadcrumbList, toOrganization, withCanonicalBase } from "./utils/jsonLD";
export { sanitizeHref, sanitizeHtml } from "./utils/sanitizeHtml";
