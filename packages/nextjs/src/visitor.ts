/**
 * How the proxy hands the pages the visitor: the request header it forwards
 * once it read the visitor (`readVisitor` from `@decocms/blocks/experiments`,
 * a new one on a first visit). The proxy writes it (`visitorRequestHeaders`
 * from `@decocms/nextjs/proxy`); the pages read it (`bindDraft`, then
 * `contentClient`, from `@decocms/nextjs/server`). The package's own copy: it
 * never imports `@decocms/tanstack`. No imports, no state: safe in every
 * bundle.
 */

/**
 * The request header carrying the visitor, in its stored form (the
 * `deco_segment` cookie's value, `serializeVisitor`). The proxy removes any
 * copy that arrives from outside (`draftRequestHeaders`).
 */
export const VISITOR_HEADER = "x-deco-visitor";
