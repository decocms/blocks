import type { BlogPost, SortBy } from "../types";
import { isLivePost } from "../types";
import { VALID_SORT_ORDERS } from "../utils/constants";
import { dateToTime } from "../utils/date";
import { getBlogRecordsAdapter } from "./blogRecords";

/**
 * Returns a sorted BlogPost list.
 *
 * @param blogPosts Posts to be sorted
 * @param sortBy Sort option ("date_desc" | "date_asc" | "title_asc" | "title_desc" | "view_asc" | "view_desc")
 */
export const sortPosts = async (blogPosts: BlogPost[], sortBy: SortBy): Promise<BlogPost[]> => {
  const splittedSort = sortBy.split("_");

  if (splittedSort[0] === "view") {
    const views = await getBlogRecordsAdapter()?.listPostViews?.();

    // No adapter (or no rows): fall through to the date sort rather than
    // returning an arbitrary order. The Deno app threw here when the `records`
    // app was missing; degrading is the deliberate difference — view sorting is
    // an enhancement, and a blog without the backend should still render.
    if (views?.length) {
      // Act like a real extension: stamp the counts onto the posts.
      for (const view of views) {
        const post = blogPosts.find(({ slug }) => slug === view.id);
        if (post) {
          post.interactionStatistic = {
            "@type": "InteractionCounter",
            userInteractionCount: view.userInteractionCount,
          };
        }
      }

      const viewSortOrder = VALID_SORT_ORDERS.includes(splittedSort[1]) ? splittedSort[1] : "desc";

      return [...blogPosts].sort((a, b) => {
        const countOfA = a?.interactionStatistic?.userInteractionCount;
        const countOfB = b?.interactionStatistic?.userInteractionCount;
        if (!countOfA && !countOfB) {
          return 0;
        }
        // NOTE: inverted, like the title branch below — `view_desc` puts the
        // *least* viewed post first. Verbatim from upstream
        // (deco-cx/apps blog/core/handlePosts.ts); only the `date` branch, which
        // compares `b - a`, reads the right way round. Kept as-is so a site
        // moving off the Deno app sees no reordering; fix it upstream first.
        const comparison = (countOfA ?? 0) - (countOfB ?? 0);
        return viewSortOrder === "desc" ? comparison : -comparison;
      });
    }
  }

  const sortMethod = (splittedSort[0] in blogPosts[0] ? splittedSort[0] : "date") as keyof BlogPost;
  const sortOrder = VALID_SORT_ORDERS.includes(splittedSort[1]) ? splittedSort[1] : "desc";

  return [...blogPosts].sort((a, b) => {
    if (!a[sortMethod] && !b[sortMethod]) {
      return 0; // Both lack the sort key — consider them equal
    }
    if (!a[sortMethod]) {
      return 1; // a lacks the sort key — put it after b
    }
    if (!b[sortMethod]) {
      return -1;
    }
    // NOTE: for the non-date keys this reads inverted — `title_asc` yields Z-A.
    // That is upstream's behaviour (deco-cx/apps blog/core/handlePosts.ts) and
    // existing content relies on it, so it is preserved here on purpose rather
    // than "fixed" as a drive-by. Don't flip it without changing upstream too.
    const comparison =
      sortMethod === "date"
        ? dateToTime(b.date) - dateToTime(a.date)
        : (a[sortMethod]?.toString().localeCompare(b[sortMethod]?.toString() ?? "") ?? 0);
    return sortOrder === "desc" ? comparison : -comparison;
  });
};

/**
 * Returns a filtered BlogPost list.
 *
 * @param posts Posts to be handled
 * @param slug Category slug to filter by
 */
export const filterPostsByCategory = (posts: BlogPost[], slug?: string): BlogPost[] =>
  slug ? posts.filter(({ categories }) => categories?.find((c) => c.slug === slug)) : posts;

/** Filter posts whose slug is in the given list. */
export const filterPostsBySlugs = (posts: BlogPost[], postSlugs: string[]): BlogPost[] =>
  posts.filter(({ slug }) => postSlugs.includes(slug));

/** Filter posts matching a search term (title, excerpt, content). */
export const filterPostsByTerm = (posts: BlogPost[], term: string): BlogPost[] =>
  posts.filter(({ content, excerpt, title }) =>
    [content, excerpt, title].some((field) => field?.toLowerCase().includes(term.toLowerCase())),
  );

/** Filter posts whose categories overlap with the given slug array. */
export const filterRelatedPosts = (posts: BlogPost[], slugs: string[]): BlogPost[] =>
  posts.filter(({ categories }) => categories?.find((c) => slugs.includes(c.slug)));

/** Slice posts for pagination. */
export const slicePosts = (
  posts: BlogPost[],
  pageNumber: number,
  postsPerPage: number,
): BlogPost[] => {
  const startIndex = (pageNumber - 1) * postsPerPage;
  return posts.slice(startIndex, startIndex + postsPerPage);
};

/**
 * A record without a slug has no route, so it can never be rendered: listing it
 * only produces cards linking to the listing itself. Posts that aren't live are
 * unreachable for a different reason — either the CMS doesn't consider them
 * ready, or they're scheduled for an instant that hasn't arrived yet — but the
 * outcome is the same, so both are dropped here, before slicePosts, so `count`
 * still yields `count` renderable posts.
 *
 * A scheduled post crossing its instant flips this filter on the next request
 * that misses cache; nothing re-deploys and no record is rewritten.
 */
export const filterRoutablePosts = (posts: BlogPost[]): BlogPost[] =>
  // Records come straight from the CMS, so `slug` is only a string by
  // convention: the typeof guard keeps a malformed one from throwing here and
  // taking the whole listing down with it.
  posts.filter((post) => typeof post.slug === "string" && post.slug.trim() && isLivePost(post));

const filterPosts = (
  allPosts: BlogPost[],
  slug?: string | string[],
  postSlugs?: string[],
  term?: string,
): BlogPost[] => {
  const posts = filterRoutablePosts(allPosts);

  if (typeof slug === "string") {
    const firstFilter =
      postSlugs && postSlugs.length > 0
        ? filterPostsBySlugs(posts, postSlugs)
        : filterPostsByCategory(posts, slug);

    return term ? filterPostsByTerm(firstFilter, term) : firstFilter;
  }
  if (Array.isArray(slug)) {
    return filterRelatedPosts(posts, slug);
  }

  return term ? filterPostsByTerm(posts, term) : posts;
};

/**
 * Returns a filtered and sorted BlogPost list. It does not slice.
 *
 * @param posts Posts to be handled
 * @param sortBy Sort option
 * @param slug Category slug, or an array of slugs, to filter by
 * @param postSlugs Specific slugs to filter by
 * @param term Term to filter by
 * @param excludePostSlug Slug to exclude
 */
export default async function handlePosts(
  posts: BlogPost[],
  sortBy: SortBy,
  slug?: string | string[],
  postSlugs?: string[],
  term?: string,
  excludePostSlug?: string,
): Promise<BlogPost[] | null> {
  const filteredPosts = filterPosts(posts, slug, postSlugs, term).filter(
    ({ slug: postSlug }) => postSlug !== excludePostSlug,
  );

  if (filteredPosts.length === 0) {
    return null;
  }

  return sortPosts(filteredPosts, sortBy);
}
