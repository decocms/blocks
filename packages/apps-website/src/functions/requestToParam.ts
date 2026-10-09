/**
 * `website/functions/requestToParam.ts` — reads a route param (e.g. `:slug`)
 * from the request URL.
 *
 * The runtime already resolves blocks saved as
 * `{ "__resolveType": "website/functions/requestToParam.ts", "param": "slug" }`
 * (`WELL_KNOWN_TYPES.REQUEST_TO_PARAM` in `@decocms/blocks/cms`). This module
 * gives sections the same prop type deco-cx/deco offered, so the schema
 * generator can emit the admin's "Force param" / "Get params from request
 * parameters" picker for it instead of a bare string.
 */

export interface Props {
  /**
   * @description Param name to extract from the Request URL
   * @default slug
   */
  param: string;
}

/**
 * A route param from the request URL, or a fixed value. Resolves to a string;
 * the schema generator recognizes this alias by name.
 */
export type RequestURLParam = string;
