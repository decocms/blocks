/**
 * App blocks → client config (spec: upstream-clients › Call a client). v7's
 * autoconfig read each commerce app's settings from a saved block it found by
 * name (`deco-vtex`, `deco-shopify`, `deco-wake`, `deco-resend`) and
 * configured a global client from it. The next major has no apps: a site
 * creates the platform's client in code. This step writes that code,
 * `src/clients/<app>.ts`, from the saved block, with v7's rules:
 *
 * - each setting the client takes, as a literal (v7's defaults applied the
 *   same way: VTEX's sales channel "1", Wake's checkout URL);
 * - each credential from the environment variable v7 fell back to
 *   (`VTEX_APP_KEY`, `SHOPIFY_STOREFRONT_TOKEN`, …), never its value: a
 *   plain string v7 accepted as is stays a literal, an encrypted one is read
 *   from the variable (the Worker's `env` on TanStack Start, `process.env` on
 *   Next.js), so the report names the variables to set;
 * - the settings v7 kept beside the client (VTEX's `publicUrl`, Resend's
 *   sender) as an exported constant for the site's code.
 *
 * The saved block stays until the variables are set (the report says to
 * delete it then: `deco check` rejects it). Returns the v7 type names handled,
 * so the block map doesn't report them again.
 */
import fs from "node:fs";
import path from "node:path";
import { type Framework, siteFramework } from "./framework";
import type { Report } from "./report";
import { isPlainObject, type JsonObject, readContent } from "./walk";

type Value = { literal: unknown } | { env: string; required: boolean };

interface AppPlan {
  pkg: string;
  create: string;
  clientType: string;
  /** The client's config, field by field. */
  config: [string, Value][];
  /** Settings v7 kept for the site's code. */
  settings: Record<string, unknown>;
}

/** A setting's text, or undefined when empty (v7 treated "" as unset). */
const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);

/** v7's resolveSecret(value, env): a plain string as is, else the environment variable. */
function secret(value: unknown, env: string, required: boolean): Value {
  const plain = str(value);
  return plain !== undefined ? { literal: plain } : { env, required };
}

/** The Storefront API version the installed v7 Shopify app spoke (latest 7.x: 2026-04). */
function shopifyApiVersion(root: string): string {
  try {
    const text = fs.readFileSync(
      path.join(root, "node_modules", "@decocms", "apps-shopify", "src", "client.ts"),
      "utf8",
    );
    const version = /\/api\/(\d{4}-\d{2})\/graphql/.exec(text)?.[1];
    if (version) return version;
  } catch {
    // Not installed: 7.x's last version.
  }
  return "2026-04";
}

/** Each v7 app's `configure(block, resolveSecret)`, as the v8 client's config. */
const APPS: Record<string, (block: JsonObject, root: string) => AppPlan | undefined> = {
  vtex: (b) => {
    const account = str(b.account);
    if (!account) return undefined;
    const config: [string, Value][] = [
      ["account", { literal: account }],
      ["salesChannel", { literal: str(b.salesChannel) ?? "1" }],
    ];
    const locale = str(b.locale) ?? str(b.defaultLocale);
    if (locale) config.push(["locale", { literal: locale }]);
    if (str(b.domain)) config.push(["domain", { literal: b.domain }]);
    config.push(["appKey", secret(b.appKey, "VTEX_APP_KEY", false)]);
    config.push(["appToken", secret(b.appToken, "VTEX_APP_TOKEN", false)]);
    const advanced = isPlainObject(b.advancedConfigs) ? b.advancedConfigs : {};
    return {
      pkg: "@decocms/apps-vtex",
      create: "createVtexClient",
      clientType: "VtexClient",
      config,
      settings: {
        publicUrl: str(b.publicUrl) ?? null,
        country: str(b.country) ?? null,
        invalidPageNotFound: advanced.invalidPageNotFound === true,
      },
    };
  },
  shopify: (b, root) => {
    const storeName = str(b.storeName);
    if (!storeName) return undefined;
    return {
      pkg: "@decocms/apps-shopify",
      create: "createShopifyClient",
      clientType: "ShopifyClient",
      config: [
        ["storeName", { literal: storeName }],
        [
          "storefrontAccessToken",
          secret(b.storefrontAccessToken, "SHOPIFY_STOREFRONT_TOKEN", true),
        ],
        ["apiVersion", { literal: shopifyApiVersion(root) }],
      ],
      settings: { publicUrl: str(b.publicUrl) ?? null },
    };
  },
  wake: (b) => {
    const account = str(b.account);
    if (!account) return undefined;
    const config: [string, Value][] = [
      // v7 read Wake's token from the environment only.
      ["storefrontToken", { env: "WAKE_TOKEN", required: true }],
      ["checkoutUrl", { literal: str(b.checkoutUrl) ?? `https://${account}.checkout.fbits.store` }],
    ];
    if (str(b.storefrontEndpoint))
      config.push(["storefrontEndpoint", { literal: b.storefrontEndpoint }]);
    return {
      pkg: "@decocms/apps-wake",
      create: "createWakeClient",
      clientType: "WakeClient",
      config,
      settings: { account },
    };
  },
  resend: (b) => {
    const from = isPlainObject(b.emailFrom) ? b.emailFrom : undefined;
    return {
      pkg: "@decocms/apps-resend",
      create: "createResendClient",
      clientType: "ResendClient",
      config: [["apiKey", secret(b.apiKey, "RESEND_API_KEY", true)]],
      settings: {
        emailFrom: from
          ? `${str(from.name) || "Contact"} <${str(from.domain) || "onboarding@resend.dev"}>`
          : null,
        emailTo: b.emailTo ?? null,
        subject: b.subject ?? null,
      },
    };
  },
};

const CLIENT_NAME: Record<string, string> = {
  vtex: "vtexClient",
  shopify: "shopifyClient",
  wake: "wakeClient",
  resend: "resendClient",
};

function render(app: string, name: string, plan: AppPlan, framework: Framework): string {
  const envNames = plan.config.flatMap(([, v]) => ("env" in v ? [v.env] : []));
  const value = (v: Value) => {
    if ("literal" in v) return JSON.stringify(v.literal);
    return v.required ? `required("${v.env}")` : `variable("${v.env}")`;
  };
  const needsRequired = plan.config.some(([, v]) => "env" in v && v.required);
  const lines = [
    "/**",
    ` * The ${app} client, configured from v7's saved app block "${name}" (v7's autoconfig read the app's`,
    " * settings from it). Generated by the deco-v7-to-v8-migration skill; it's your code now.",
    ...(envNames.length > 0
      ? [
          ` * Credentials come from the environment variables v7 fell back to (${envNames.join(", ")});`,
          ` * set them as ${framework === "tanstack" ? "the Worker's secrets (wrangler secret put)" : "the deployment's environment variables"}.`,
        ]
      : []),
    " */",
    `import { ${plan.create}, type ${plan.clientType} } from "${plan.pkg}";`,
  ];
  if (envNames.length > 0) {
    if (framework === "tanstack") {
      lines.push(
        'import { env } from "cloudflare:workers";',
        "",
        "/** An environment variable of the Worker. */",
        "const variable = (name: string) =>",
        "  (env as unknown as Record<string, string | undefined>)[name] || undefined;",
      );
    } else {
      lines.push(
        "",
        "/** An environment variable of the server. */",
        "const variable = (name: string) => process.env[name] || undefined;",
      );
    }
    if (needsRequired) {
      lines.push(
        "",
        "const required = (name: string) => {",
        "  const value = variable(name);",
        `  if (!value) throw new Error(\`${app} isn't configured: set \${name} (v7 read it from the saved "${name}" block or the environment)\`);`,
        "  return value;",
        "};",
      );
    }
  }
  const settings = Object.entries(plan.settings);
  if (settings.length > 0) {
    lines.push(
      "",
      `/** What v7's ${app} app kept beside its client, for the site's code. */`,
      `export const ${app}Settings = ${JSON.stringify(plan.settings, null, 2)} as const;`,
    );
  }
  lines.push(
    "",
    `let client: ${plan.clientType} | undefined;`,
    "",
    `/** The ${app} client, created on first use. */`,
    `export function ${CLIENT_NAME[app]}(): ${plan.clientType} {`,
    `  client ??= ${plan.create}({`,
    ...plan.config.map(([field, v]) => `    ${field}: ${value(v)},`),
    "  });",
    "  return client;",
    "}",
    "",
  );
  return lines.join("\n");
}

/** Writes `src/clients/<app>.ts` for each v7 app block. Returns the v7 type names handled. */
export function writeAppClients(root: string, report: Report): Set<string> {
  const handled = new Set<string>();
  const framework = siteFramework(root);
  const { blocks, files } = readContent(root);
  for (const [name, block] of Object.entries(blocks)) {
    const app = /^deco-([a-z]+)$/.exec(name)?.[1];
    if (!app || !isPlainObject(block)) continue;
    const type = typeof block.__resolveType === "string" ? block.__resolveType : "";
    // v7's app blocks: `site/apps/deco/<app>.ts` (or the app's own mod).
    if (!/(^|\/)apps\/|\/mod\.tsx?$/.test(type)) continue;
    const file = files[name];
    const subject = `${file} (${type})`;
    handled.add(type);
    if (app === "analytics" || app === "htmx") {
      report.manual.push({
        step: "apps",
        subject,
        message:
          app === "htmx"
            ? "v7's HTMX app: v7 on TanStack Start and Next.js loaded no HTMX from it; delete the saved block"
            : "v7's analytics app: analytics is the analytics section of the CMS block now (AnalyticsScript from @decocms/blocks/analytics, /next/analytics); delete the saved block",
      });
      continue;
    }
    const make = APPS[app];
    if (!make) {
      report.manual.push({
        step: "apps",
        subject,
        message:
          app === "nuvemshop"
            ? "v7's Nuvemshop app: the next major has no Nuvemshop client; call the platform from site code over createInstrumentedFetch (/next/upstream-clients#write-a-client), then delete the saved block"
            : "a v7 app block: create its client in code with these settings (/next/upstream-clients#call-a-client), then delete the saved block",
      });
      continue;
    }
    const plan = make(block, root);
    if (!plan || !framework) {
      report.manual.push({
        step: "apps",
        subject,
        message: !plan
          ? `v7's ${app} app had no ${app === "resend" ? "API key" : "account"} in it, so v7 never configured it: delete the saved block`
          : `v7's ${app} app: create the ${app} client in code with these settings (/next/upstream-clients#call-a-client), then delete the saved block`,
      });
      continue;
    }
    const out = path.join(root, "src", "clients", `${app}.ts`);
    const rel = path.relative(root, out).split(path.sep).join("/");
    if (fs.existsSync(out)) {
      report.manual.push({
        step: "apps",
        subject: rel,
        message: `already exists, so it was kept: configure ${plan.create} from the saved "${name}" block's settings`,
      });
      continue;
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, render(app, name, plan, framework));
    const envNames = plan.config.flatMap(([, v]) => ("env" in v ? [v.env] : []));
    report.done.push({
      step: "apps",
      subject: rel,
      message: `${CLIENT_NAME[app]}() creates ${plan.create} (${plan.pkg}) from the saved "${name}" block's settings, with v7's defaults`,
    });
    report.manual.push({
      step: "apps",
      subject,
      message: `${envNames.length > 0 ? `set ${envNames.join(", ")} (the credentials v7 read from this block or, failing that, from those variables), then ` : ""}delete the saved block: ${rel} holds its settings now, and deco check rejects it. Call ${CLIENT_NAME[app]}() where the vendored ${app} code reads v7's global config`,
    });
  }
  return handled;
}
