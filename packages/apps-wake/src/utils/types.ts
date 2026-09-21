/**
 * A prop resolved from the request URL by the CMS/router. In the Deco/Deno
 * runtime this came from `website/functions/requestToParam.ts`; here it is a
 * plain string (e.g. a route slug) supplied by the loader caller.
 */
export type RequestURLParam = string;
