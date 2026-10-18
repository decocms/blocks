/**
 * @decocms/compat-v7/sections: v7's section loader runner and its mixins,
 * with v7's rules. A loader is `(props, req)`; v7's third argument, `ctx`,
 * is gone and throws when read. See `runner.ts` for the rules kept and the
 * ones dropped.
 */
export { compose, withDevice, withMobile, withSearchParam, withSectionLoader } from "./mixins.ts";
export {
  type RunSectionLoadersOptions,
  runSectionLoader,
  runSectionLoaders,
  type Section,
  type SectionLoaderFn,
  type SectionLoadersResult,
} from "./runner.ts";
