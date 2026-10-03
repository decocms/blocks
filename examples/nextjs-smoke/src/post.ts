import type { Route } from "@decocms/blocks";

export interface Post extends Route {
  /**
   * @title Published on
   * @format date
   */
  date: string;
  /** @format rich-text */
  body: string;
}
