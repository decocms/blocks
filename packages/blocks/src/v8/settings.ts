/**
 * The CMS settings (see /next/built-in-blocks#cms-settings and
 * /next/api-reference#cms-settings): the saved block `CMS`, of the built-in
 * type `cms-settings`, read from the release, with the defaults filled in and
 * code's caps applied.
 *
 * - The caller hands in the release snapshot already in memory; nothing here
 *   loads content, so reading settings never fetches.
 * - A missing block, a block of another type, or a section that fails to
 *   resolve gives that section's defaults, still capped. Nothing rejects.
 * - Telemetry rates are the lower of content's and `telemetry.limits`.
 * - Preview hosts aren't content: Studio writes them into the release
 *   metadata (PO 2026-10-22), and `previewHosts` merges them with code's
 *   `preview.hosts`. A remote site with no list published (no `latest.json`
 *   yet, or one without `previewHosts`): every host. Content with no remote
 *   site: code's list, else every host. Metadata that couldn't be read:
 *   code's list alone, or none. `["*"]` means every host.
 */
import {
  analyticsSection,
  SETTINGS_BLOCK,
  SETTINGS_TYPE,
  telemetrySection,
} from "./builtins/data.ts";
import type { ReleasePreviewHosts } from "./content.ts";
import { EVERY_HOST, formatHostPattern, type HostPattern, parseHostPattern } from "./hosts.ts";
import { isPlainObject } from "./json.ts";
import type { Client, CMSConfig, EffectiveSettings, Snapshot } from "./types.ts";

/** What code allows: the caps every section's content is held to. */
export interface SettingsCaps {
  limits: { errorSampleRate: number; traceSampleRate: number };
}

/** The settings a release's `CMS` block holds: every section but `preview`, which isn't content. */
export type SavedSettings = Omit<EffectiveSettings, "preview">;

const SECTIONS = ["telemetry", "analytics"] as const;

/**
 * Code's `preview.hosts`, parsed. Throws a `TypeError` on anything that isn't
 * a list of host patterns: that's a bug in the app, not in content.
 */
export function parseCodeHosts(preview: CMSConfig["preview"]): HostPattern[] | undefined {
  return parseCodePatterns(preview, "hosts");
}

function parseCodePatterns(
  preview: CMSConfig["preview"],
  field: "hosts",
): HostPattern[] | undefined {
  if (preview === undefined || preview === null) return undefined;
  if (typeof preview !== "object") {
    throw new TypeError("createCMS: `preview` must be an object, such as { hosts: [...] }");
  }
  const list = preview[field];
  if (list === undefined) return undefined;
  if (!Array.isArray(list)) {
    throw new TypeError(`createCMS: \`preview.${field}\` must be a list of host patterns`);
  }
  return list.map((raw) => {
    const pattern = parseHostPattern(raw);
    if (pattern === null) {
      throw new TypeError(
        `createCMS: ${JSON.stringify(raw)} in preview.${field} isn't a host pattern ` +
          "(see /next/api-reference#host-patterns)",
      );
    }
    return pattern;
  });
}

/** The settings with nothing saved: every default, capped. */
export function defaultSettings(caps: SettingsCaps): SavedSettings {
  return effectiveSettings({}, caps);
}

/**
 * The settings a release holds. `client` reads that same release; it resolves
 * the `CMS` block whole and, if that fails, each section on its own, so one
 * failing section falls back to its defaults alone.
 */
export async function readSettings(
  snapshot: Snapshot | undefined,
  client: () => Client,
  caps: SettingsCaps,
): Promise<SavedSettings> {
  try {
    const entry = snapshot?.blocks[SETTINGS_BLOCK];
    if (!isPlainObject(entry) || entry.__resolveType !== SETTINGS_TYPE) {
      return defaultSettings(caps);
    }
    const reader = client();
    const [whole] = await reader.resolve<Record<string, unknown>>(SETTINGS_BLOCK);
    if (isPlainObject(whole)) return effectiveSettings(whole, caps);
    const sections: Record<string, unknown> = {};
    await Promise.all(
      SECTIONS.map(async (name) => {
        if (entry[name] === undefined) return;
        const [value] = await reader.resolve(entry[name]);
        sections[name] = value ?? undefined; // a section that fails gets its defaults
      }),
    );
    return effectiveSettings(sections, caps);
  } catch {
    return defaultSettings(caps);
  }
}

/** Whether a saved block holds nothing to run, so its settings are the same on every call. */
export function isStatic(entry: Record<string, unknown>): boolean {
  return Object.entries(entry).every(
    ([key, value]) => key === "__resolveType" || !holdsBlock(value),
  );
}

function holdsBlock(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(holdsBlock);
  if (!isPlainObject(value)) return false;
  return "__resolveType" in value || Object.values(value).some(holdsBlock);
}

/**
 * The settings, deep-frozen: one object per release is handed to every caller,
 * so a caller that writes to it would change it for every request.
 */
function effectiveSettings(value: Record<string, unknown>, caps: SettingsCaps): SavedSettings {
  const telemetry = telemetrySection(value.telemetry);
  return deepFreeze({
    telemetry: {
      ...telemetry,
      errorSampleRate: Math.min(telemetry.errorSampleRate, caps.limits.errorSampleRate),
      traceSampleRate: Math.min(telemetry.traceSampleRate, caps.limits.traceSampleRate),
    },
    analytics: analyticsSection(value.analytics),
  });
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * The preview hosts in effect, in their normal form, each once:
 * - the release has a list: it (entries that aren't host patterns left out)
 *   plus code's `preview.hosts`;
 * - a remote site published no list (`"every"`): every host (`["*"]`);
 * - no remote site (`"local"`): code's `preview.hosts` when set, else every host;
 * - the release metadata couldn't be read (`"unknown"`): code's alone, or
 *   none, so a failed read never opens previews.
 */
export function previewHosts(
  release: ReleasePreviewHosts,
  code: readonly HostPattern[] | undefined,
): string[] {
  if (release === "every" || (release === "local" && code === undefined)) return [EVERY_HOST];
  const listed = typeof release === "string" ? [] : release.map((raw) => parseHostPattern(raw));
  const patterns = [...listed, ...(code ?? [])].filter(
    (pattern): pattern is HostPattern => pattern !== null,
  );
  return unique(patterns.map(formatHostPattern));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
