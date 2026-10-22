/**
 * The forms of the twelve built-in blocks (spec: built-in-blocks, and the types
 * in api-reference › Types). They're always in the schema, unless the block
 * map declares the same key, which replaces the built-in.
 */
import { lazySchema, resolvableRef, sectionRef } from "./typeToSchema.ts";

export type ManifestGroup = "sections" | "matchers" | "loaders" | "pages" | "redirects" | "content";

export const BUILT_IN_GROUPS: Record<string, ManifestGroup> = {
  lazy: "loaders",
  multivariate: "loaders",
  always: "matchers",
  never: "matchers",
  experiment: "matchers",
  campaign: "matchers",
  page: "pages",
  redirect: "redirects",
  "cms-settings": "content",
  secret: "loaders",
  "split-traffic": "content",
  calendar: "content",
};

const BUILT_IN_DOCS: Record<string, { title: string; description: string; icon?: string }> = {
  lazy: { title: "Lazy", description: "Resolves its value only when the function calls it" },
  multivariate: {
    title: "Variants",
    description: "Picks the first variant whose rule is true",
    icon: "arrow-split",
  },
  always: { title: "Always", description: "Always true: the fallback variant", icon: "eye" },
  never: { title: "Never", description: "Always false: hides a block", icon: "eye-off" },
  experiment: {
    title: "A/B test",
    description: "True for the visitors in a test of the saved block experiments",
    icon: "flask",
  },
  campaign: {
    title: "Campaign",
    description: "True while a campaign of the saved block campaigns is running",
    icon: "calendar-event",
  },
  page: { title: "Page", description: "A page at a URL" },
  redirect: { title: "Redirect", description: "Sends one URL to another" },
  "cms-settings": {
    title: "CMS settings",
    description: "Preview hosts, telemetry and analytics: the saved block named CMS",
    icon: "settings",
  },
  "split-traffic": {
    title: "Split traffic",
    description:
      "A/B tests: each name with the percentage of visitors in it (0 off, 100 everyone); resolves to whether the visitor is in each. The type of the saved block experiments",
    icon: "flask",
  },
  calendar: {
    title: "Calendar",
    description:
      "Campaigns: each name with its start and end; resolves to whether each is running now. The type of the saved block campaigns",
    icon: "calendar-event",
  },
  secret: { title: "Secret", description: "An encrypted value, decrypted on the server" },
};

/** The form of each test in a `split-traffic` block: a whole percentage. */
const ALLOCATION = {
  type: "integer",
  title: "Visitors in (%)",
  description: "0 turns the test off, 100 shows it to everyone",
  minimum: 0,
  maximum: 100,
};

/** The form of each campaign in a `calendar` block: one window, both bounds optional. */
const CAMPAIGN_DATES = {
  type: "object",
  title: "Campaign dates",
  properties: {
    start: {
      type: "string",
      format: "date-time",
      title: "Start",
      description:
        "The campaign runs from this moment on: a date and time with your store's offset (empty: since always)",
    },
    end: {
      type: "string",
      format: "date-time",
      title: "End",
      description:
        "The campaign stops at this moment: a date and time with your store's offset (empty: never)",
    },
  },
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

function builtInProps(name: string, ctx: BuiltInContext): any {
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
    case "experiment":
      return {
        type: "object",
        required: ["name"],
        properties: {
          name: {
            type: "string",
            title: "Test",
            description: "A test in the saved block experiments",
          },
        },
      };
    case "campaign":
      return {
        type: "object",
        required: ["name"],
        properties: {
          name: {
            type: "string",
            title: "Campaign",
            description: "A campaign in the saved block campaigns",
          },
        },
      };
    case "split-traffic":
    case "calendar":
      // The names are the content: every key but __resolveType is one (see builtInDefinition).
      return { type: "object", properties: {} };
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
    case "cms-settings":
      return {
        type: "object",
        properties: {
          preview: {
            type: "object",
            title: "Preview",
            properties: {
              hosts: {
                type: "array",
                title: "Hosts",
                description:
                  "Host patterns drafts may be previewed on, such as staging.example.com or *.example.com; empty turns previews off. Without it, only the hosts code allows, if any: previews from the site editor work only on the hosts listed here or in code.",
                items: { type: "string" },
              },
            },
          },
          telemetry: {
            type: "object",
            title: "Telemetry",
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
          },
          analytics: {
            type: "object",
            title: "Analytics",
            properties: {
              collector: { type: "string", title: "Collector" },
              enabled: { type: "boolean", title: "Enabled", default: true },
            },
          },
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

export function builtInDefinition(name: string, ctx: BuiltInContext): any {
  const docs = BUILT_IN_DOCS[name];
  return flatDefinition(name, builtInProps(name, ctx), {
    description: docs.description,
    ...(docs.icon ? { icon: docs.icon } : {}),
    ...(name === "split-traffic" ? { additionalProperties: ALLOCATION } : {}),
    ...(name === "calendar" ? { additionalProperties: CAMPAIGN_DATES } : {}),
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
    default:
      return { title: "Value" };
  }
}
