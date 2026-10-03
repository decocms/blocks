/**
 * The forms of the ten built-in blocks (spec: built-in-blocks, and the types
 * in api-reference › Types). They're always in the schema, unless the block
 * map declares the same key, which replaces the built-in.
 */
import type { BuiltInBlock } from "../builtins";
import { lazySchema, resolvableRef, sectionRef, toBase64 } from "./typeToSchema";

export type ManifestGroup = "sections" | "matchers" | "loaders" | "pages" | "redirects" | "content";

export const BUILT_IN_GROUPS: Record<BuiltInBlock, ManifestGroup> = {
  lazy: "loaders",
  multivariate: "loaders",
  always: "matchers",
  never: "matchers",
  date: "matchers",
  page: "pages",
  redirect: "redirects",
  telemetry: "content",
  analytics: "content",
  secret: "loaders",
};

const BUILT_IN_DOCS: Record<BuiltInBlock, { title: string; description: string; icon?: string }> = {
  lazy: { title: "Lazy", description: "Resolves its value only when the function calls it" },
  multivariate: {
    title: "Variants",
    description: "Picks the first variant whose rule is true",
    icon: "arrow-split",
  },
  always: { title: "Always", description: "Always true: the fallback variant", icon: "eye" },
  never: { title: "Never", description: "Always false: hides a block", icon: "eye-off" },
  date: {
    title: "Date and time",
    description: "True from start until end",
    icon: "calendar-event",
  },
  page: { title: "Page", description: "A page at a URL" },
  redirect: { title: "Redirect", description: "Sends one URL to another" },
  telemetry: { title: "Telemetry", description: "Telemetry switches and sample rates" },
  analytics: { title: "Analytics", description: "Page view analytics settings" },
  secret: { title: "Secret", description: "An encrypted value, decrypted on the server" },
};

function resolveTypeProperty(key: string) {
  return { type: "string", enum: [key], default: key };
}

/** A flat block definition: `__resolveType` plus the props, as v7 wrote loaders. */
export function flatDefinition(
  key: string,
  props: { properties?: Record<string, any>; required?: string[]; [k: string]: any },
  extra: Record<string, any> = {},
): any {
  // Only the fields, as v7 wrote loaders: a props type's own annotations
  // (nullable, hide) describe a field, not the block.
  const { properties = {}, required = [] } = props;
  return {
    title: key,
    ...extra,
    type: "object",
    required: ["__resolveType", ...required.filter((r) => r !== "__resolveType")],
    properties: { __resolveType: resolveTypeProperty(key), ...properties },
  };
}

export interface BuiltInContext {
  /** `$ref`s of the blocks whose return type fits `Seo`, for the page's `seo` field. */
  seoRefs: { $ref: string }[];
}

/** The rule field of a variant: a block whose function returns a boolean. */
function ruleSchema() {
  return { title: "Rule", $ref: "#/root/matchers" };
}

/** The `variants` list of a multivariate block whose variants have the form `value`. */
function variantsSchema(value: any) {
  return {
    type: "array",
    title: "Variants",
    items: {
      type: "object",
      required: ["rule", "value"],
      properties: {
        rule: ruleSchema(),
        value,
      },
    },
  };
}

function builtInProps(name: BuiltInBlock, ctx: BuiltInContext): any {
  switch (name) {
    case "lazy":
      return lazySchema({ title: "Value" });
    case "multivariate":
      return {
        type: "object",
        required: ["variants"],
        properties: {
          // Under the short name, each value is wrapped in a lazy block, so
          // only the picked variant's value resolves (spec: built-in-blocks ›
          // Variants). Legacy names store it plain: see legacyMultivariateValue.
          variants: variantsSchema(lazySchema({ title: "Value" })),
          experiment: {
            type: "string",
            title: "Experiment",
            description: "The stable ID of an A/B test",
          },
        },
      };
    case "always":
    case "never":
      return { type: "object", properties: {} };
    case "date":
      return {
        type: "object",
        properties: {
          start: { type: "string", format: "date-time", title: "Start" },
          end: { type: "string", format: "date-time", title: "End" },
        },
      };
    case "page":
      return {
        type: "object",
        required: ["name", "path", "sections"],
        properties: {
          name: { type: "string", title: "Name" },
          path: { type: "string", title: "Path" },
          seo: { title: "SEO", anyOf: [resolvableRef(), ...ctx.seoRefs], nullable: true },
          sections: {
            title: "Sections",
            anyOf: [
              { type: "array", title: "Sections", items: sectionRef() },
              sectionListVariants(["multivariate"], true),
              sectionListVariants(
                ["website/flags/multivariate.ts", "website/flags/multivariate/section.ts"],
                false,
              ),
            ],
          },
        },
      };
    case "redirect":
      return {
        type: "object",
        required: ["from", "to", "permanent"],
        properties: {
          from: { type: "string", title: "From" },
          to: { type: "string", title: "To" },
          permanent: {
            type: "boolean",
            title: "Permanent",
            description: "301 when true, 302 otherwise",
          },
          status: { type: "number", enum: [301, 302, 307, 308], title: "Status" },
          discardQueryParameters: { type: "boolean", title: "Discard query parameters" },
        },
      };
    case "telemetry":
      return {
        type: "object",
        properties: {
          enabled: { type: "boolean", title: "Enabled", default: true },
          metrics: { type: "boolean", title: "Metrics", default: true },
          errorSampleRate: {
            type: "number",
            title: "Error sample rate",
            minimum: 0,
            maximum: 1,
            default: 0.05,
          },
          traceSampleRate: {
            type: "number",
            title: "Trace sample rate",
            minimum: 0,
            maximum: 1,
            default: 0,
          },
        },
      };
    case "analytics":
      return {
        type: "object",
        properties: {
          collector: { type: "string", title: "Collector" },
          enabled: { type: "boolean", title: "Enabled", default: true },
        },
      };
    case "secret":
      return {
        type: "object",
        required: ["ciphertext"],
        properties: { ciphertext: { type: "string", title: "Ciphertext", writeOnly: true } },
      };
  }
}

/**
 * A whole `sections` list with variants: each value is a list of sections,
 * in a lazy block under `multivariate` and plain under the legacy names.
 */
function sectionListVariants(names: string[], lazy: boolean) {
  const sections = { type: "array", title: "Sections", items: sectionRef() };
  return {
    type: "object",
    title: lazy ? "Variants" : "Variants (legacy)",
    required: ["__resolveType"],
    properties: {
      __resolveType: { type: "string", enum: names },
      variants: variantsSchema(lazy ? lazySchema(sections) : sections),
    },
  };
}

export function builtInDefinition(name: BuiltInBlock, ctx: BuiltInContext): any {
  const docs = BUILT_IN_DOCS[name];
  return flatDefinition(name, builtInProps(name, ctx), {
    description: docs.description,
    ...(docs.icon ? { icon: docs.icon } : {}),
  });
}

/**
 * The per-kind multivariate definitions the site editor's field-variant UI
 * reads (`variants.items.properties.value` is the form of the field). Legacy
 * names store plain values; `multivariate` itself stores lazy ones.
 */
export function legacyMultivariateValue(alias: string): any {
  switch (alias) {
    case "website/flags/multivariate/section.ts":
      return { ...sectionRef(), title: "Section" };
    case "website/flags/multivariate/image.ts":
      return { type: "string", format: "image-uri", title: "Image" };
    case "website/flags/multivariate/message.ts":
      return { type: "string", title: "Message" };
    case "website/flags/multivariate/page.ts":
      return { $ref: `#/definitions/${toBase64("page")}`, title: "Page" };
    default:
      return { title: "Value" };
  }
}
