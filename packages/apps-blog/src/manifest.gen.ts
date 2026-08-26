// AUTO-GENERATED shape, HAND-MAINTAINED file.
// `scripts/generate-manifests.ts` was never ported into this repo (deferred in
// docs/apps-monorepo-migration-plan.md); until it is, add new loaders/actions/
// sections here by hand. Checked into source control (see .gitignore's
// `!packages/apps-*/src/manifest.gen.ts` negation).
import * as actions_submitRating from "./actions/submitRating";
import * as actions_submitReview from "./actions/submitReview";
import * as actions_submitView from "./actions/submitView";
import * as loaders_Author from "./loaders/Author";
import * as loaders_BlogPostItem from "./loaders/BlogPostItem";
import * as loaders_BlogPostPage from "./loaders/BlogPostPage";
import * as loaders_Blogpost from "./loaders/Blogpost";
import * as loaders_BlogpostList from "./loaders/BlogpostList";
import * as loaders_BlogpostListing from "./loaders/BlogpostListing";
import * as loaders_BlogRelatedPosts from "./loaders/BlogRelatedPosts";
import * as loaders_Category from "./loaders/Category";
import * as loaders_ext_BlogpostList_ratings from "./loaders/extensions/BlogpostList/ratings";
import * as loaders_ext_BlogpostList_reviews from "./loaders/extensions/BlogpostList/reviews";
import * as loaders_ext_BlogpostListing_ratings from "./loaders/extensions/BlogpostListing/ratings";
import * as loaders_ext_BlogpostListing_reviews from "./loaders/extensions/BlogpostListing/reviews";
import * as loaders_ext_BlogpostPage_ratings from "./loaders/extensions/BlogpostPage/ratings";
import * as loaders_ext_BlogpostPage_reviews from "./loaders/extensions/BlogpostPage/reviews";
import * as loaders_GetCategories from "./loaders/GetCategories";

const sections_Seo_SeoBlogPost = () => import("./sections/Seo/SeoBlogPost");
const sections_Seo_SeoBlogPostListing = () => import("./sections/Seo/SeoBlogPostListing");
const sections_Template = () => import("./sections/Template");
const sections_blocks_BlockImage = () => import("./sections/blocks/BlockImage");
const sections_blocks_Callout = () => import("./sections/blocks/Callout");
const sections_blocks_CardGroup = () => import("./sections/blocks/CardGroup");
const sections_blocks_Checklist = () => import("./sections/blocks/Checklist");
const sections_blocks_Code = () => import("./sections/blocks/Code");
const sections_blocks_Comparison = () => import("./sections/blocks/Comparison");
const sections_blocks_Cta = () => import("./sections/blocks/Cta");
const sections_blocks_Divider = () => import("./sections/blocks/Divider");
const sections_blocks_Heading = () => import("./sections/blocks/Heading");
const sections_blocks_List = () => import("./sections/blocks/List");
const sections_blocks_Paragraph = () => import("./sections/blocks/Paragraph");
const sections_blocks_Quote = () => import("./sections/blocks/Quote");
const sections_blocks_Stat = () => import("./sections/blocks/Stat");
const sections_blocks_StatGroup = () => import("./sections/blocks/StatGroup");
const sections_blocks_Steps = () => import("./sections/blocks/Steps");
const sections_blocks_Table = () => import("./sections/blocks/Table");
const sections_blocks_Video = () => import("./sections/blocks/Video");

const manifest = {
  name: "blog",
  loaders: {
    "blog/loaders/Author": loaders_Author,
    "blog/loaders/Blogpost": loaders_Blogpost,
    "blog/loaders/BlogPostItem": loaders_BlogPostItem,
    "blog/loaders/BlogPostPage": loaders_BlogPostPage,
    "blog/loaders/BlogpostList": loaders_BlogpostList,
    "blog/loaders/BlogpostListing": loaders_BlogpostListing,
    "blog/loaders/BlogRelatedPosts": loaders_BlogRelatedPosts,
    "blog/loaders/Category": loaders_Category,
    "blog/loaders/GetCategories": loaders_GetCategories,
    "blog/loaders/extensions/BlogpostList/ratings": loaders_ext_BlogpostList_ratings,
    "blog/loaders/extensions/BlogpostList/reviews": loaders_ext_BlogpostList_reviews,
    "blog/loaders/extensions/BlogpostListing/ratings": loaders_ext_BlogpostListing_ratings,
    "blog/loaders/extensions/BlogpostListing/reviews": loaders_ext_BlogpostListing_reviews,
    "blog/loaders/extensions/BlogpostPage/ratings": loaders_ext_BlogpostPage_ratings,
    "blog/loaders/extensions/BlogpostPage/reviews": loaders_ext_BlogpostPage_reviews,
  },
  actions: {
    "blog/actions/submitRating": actions_submitRating,
    "blog/actions/submitReview": actions_submitReview,
    "blog/actions/submitView": actions_submitView,
  },
  sections: {
    "blog/sections/Seo/SeoBlogPost": sections_Seo_SeoBlogPost,
    "blog/sections/Seo/SeoBlogPostListing": sections_Seo_SeoBlogPostListing,
    "blog/sections/Template": sections_Template,
    "blog/sections/blocks/BlockImage": sections_blocks_BlockImage,
    "blog/sections/blocks/Callout": sections_blocks_Callout,
    "blog/sections/blocks/CardGroup": sections_blocks_CardGroup,
    "blog/sections/blocks/Checklist": sections_blocks_Checklist,
    "blog/sections/blocks/Code": sections_blocks_Code,
    "blog/sections/blocks/Comparison": sections_blocks_Comparison,
    "blog/sections/blocks/Cta": sections_blocks_Cta,
    "blog/sections/blocks/Divider": sections_blocks_Divider,
    "blog/sections/blocks/Heading": sections_blocks_Heading,
    "blog/sections/blocks/List": sections_blocks_List,
    "blog/sections/blocks/Paragraph": sections_blocks_Paragraph,
    "blog/sections/blocks/Quote": sections_blocks_Quote,
    "blog/sections/blocks/Stat": sections_blocks_Stat,
    "blog/sections/blocks/StatGroup": sections_blocks_StatGroup,
    "blog/sections/blocks/Steps": sections_blocks_Steps,
    "blog/sections/blocks/Table": sections_blocks_Table,
    "blog/sections/blocks/Video": sections_blocks_Video,
  },
} as const;

export type Manifest = typeof manifest;
export default manifest;
