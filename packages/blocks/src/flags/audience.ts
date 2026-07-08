import type { FlagObj, Matcher } from "./types";
import Flag from "./flag";

/**
 * @title Site Route
 * @titleBy pathTemplate
 */
export interface Route {
  pathTemplate: string;
  /**
   * @description if true so the path will be checked against the coming from request instead of using urlpattern.
   */
  isHref?: boolean;
  handler: {
    value: unknown;
  };
  /**
   * @title Priority
   * @description higher priority means that this route will be used in favor of other routes with less or none priority
   */
  highPriority?: boolean;
}

/**
 * @title Routes
 * @description Used to configure your site routes
 */
export type Routes = Route[];

/**
 * @titleBy name
 */
export interface Audience {
  matcher: Matcher;
  /**
   * @title The audience name (will be used on cookies).
   * @description Add a meaningful short word for the audience name.
   * @minLength 3
   * @pattern ^[A-Za-z0-9_-]+$
   */
  name: string;
  routes?: Routes;
}

/**
 * @title Audience
 * @description Select routes based on the matched audience.
 */
export default function Audience({ matcher, routes, name }: Audience): FlagObj<Route[]> {
  return Flag<Route[]>({
    matcher,
    true: routes ?? [],
    false: [],
    name,
  });
}
