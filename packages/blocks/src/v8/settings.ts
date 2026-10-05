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
 * - Preview hosts: content's entries that fall within code's `preview.hosts`
 *   (all of them when code sets none); without the field, code's list, or
 *   every host.
 */
import {
  analyticsSection,
  SETTINGS_BLOCK,
  SETTINGS_TYPE,
  telemetrySection,
} from "./builtins/data.ts";
import {
  EVERY_HOST,
  formatHostPattern,
  type HostPattern,
  parseHostPattern,
  patternWithin,
} from "./hosts.ts";
import { isPlainObject } from "./json.ts";
import type { Client, CMSConfig, EffectiveSettings, Snapshot } from "./types.ts";

/** What code allows: the caps every section's content is held to. */
export interface SettingsCaps {
  /** Code's `preview.hosts`, parsed; `undefined` when code sets none. */
  hosts: readonly HostPattern[] | undefined;
  limits: { errorSampleRate: number; traceSampleRate: number };
}

const SECTIONS = ["preview", "telemetry", "analytics"] as const;

/**
 * Code's `preview.hosts`, parsed. Throws a `TypeError` on anything that isn't
 * a list of host patterns: that's a bug in the app, not in content.
 */
export function parseCodeHosts(preview: CMSConfig["preview"]): HostPattern[] | undefined {
  if (preview === undefined || preview === null) return undefined;
  if (typeof preview !== "object") {
    throw new TypeError("createCMS: `preview` must be an object, such as { hosts: [...] }");
  }
  const { hosts } = preview;
  if (hosts === undefined) return undefined;
  if (!Array.isArray(hosts)) {
    throw new TypeError("createCMS: `preview.hosts` must be a list of host patterns");
  }
  return hosts.map((raw) => {
    const pattern = parseHostPattern(raw);
    if (pattern === null) {
      throw new TypeError(
        `createCMS: ${JSON.stringify(raw)} in preview.hosts isn't a host pattern ` +
          "(see /next/api-reference#host-patterns)",
      );
    }
    return pattern;
  });
}

/** The settings with nothing saved: every default, capped. */
export function defaultSettings(caps: SettingsCaps): EffectiveSettings {
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
): Promise<EffectiveSettings> {
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

function effectiveSettings(value: Record<string, unknown>, caps: SettingsCaps): EffectiveSettings {
  const telemetry = telemetrySection(value.telemetry);
  return {
    preview: { hosts: effectiveHosts(value.preview, caps.hosts) },
    telemetry: {
      ...telemetry,
      errorSampleRate: Math.min(telemetry.errorSampleRate, caps.limits.errorSampleRate),
      traceSampleRate: Math.min(telemetry.traceSampleRate, caps.limits.traceSampleRate),
    },
    analytics: analyticsSection(value.analytics),
  };
}

function effectiveHosts(preview: unknown, code: readonly HostPattern[] | undefined): string[] {
  const saved = isPlainObject(preview) && Array.isArray(preview.hosts) ? preview.hosts : undefined;
  if (saved === undefined) return code ? unique(code.map(formatHostPattern)) : [EVERY_HOST];
  const kept: string[] = [];
  for (const raw of saved) {
    const pattern = parseHostPattern(raw);
    if (pattern === null) continue; // not a pattern: left out
    if (code && !code.some((cap) => patternWithin(pattern, cap))) continue;
    kept.push(formatHostPattern(pattern));
  }
  return unique(kept);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
