import {
  getSection,
  loadBlocks,
  type MatcherContext,
  type ResolvedSection,
  resolvePageSections,
  resolveValue,
  runSingleSectionLoader,
  WELL_KNOWN_TYPES,
  withBlocksOverride,
} from "@decocms/blocks/cms";

export type PreviewResolution =
  | {
      type: "sections";
      previewType: "page" | "section";
      component: string;
      sections: ResolvedSection[];
    }
  | { type: "unknown"; component: string };

type PreviewInput = {
  component: string;
  props: Record<string, unknown>;
  decofileOverride: Record<string, unknown> | null;
};

function decodePreviewPath(value: string): string {
  try {
    const once = decodeURIComponent(value);
    try {
      return decodeURIComponent(once);
    } catch {
      return once;
    }
  } catch {
    return value;
  }
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function parsePreviewInput(request: Request): Promise<PreviewInput> {
  const url = new URL(request.url);
  const resolveChain = url.searchParams.get("resolveChain");
  const propsParam = url.searchParams.get("props");
  const pathPrefix = "/live/previews/";
  const rawPathComponent = url.pathname.startsWith(pathPrefix)
    ? url.pathname.slice(pathPrefix.length)
    : "";

  let component = resolveChain || decodePreviewPath(rawPathComponent) || "";
  let props: Record<string, unknown> = {};
  let decofileOverride: Record<string, unknown> | null = null;

  if (request.method === "POST") {
    try {
      const body = (await request.json()) as Record<string, unknown> | null;
      if (body && typeof body === "object") {
        if (body.__decofile && typeof body.__decofile === "object") {
          decofileOverride = body.__decofile as Record<string, unknown>;
        }
        if (body.__props && typeof body.__props === "object") {
          props = body.__props as Record<string, unknown>;
          if (typeof props.__resolveType === "string") {
            component = props.__resolveType;
          }
        } else if (body.props && typeof body.props === "object") {
          props = body.props as Record<string, unknown>;
        } else if (typeof body.__resolveType === "string") {
          component = body.__resolveType;
          const { __decofile: _, __resolveType: __, ...rest } = body;
          props = rest;
        } else if (!body.__decofile) {
          props = body;
        }
      }
    } catch {
      // Fall through to query-param parsing.
    }
  }

  if (!decofileOverride) {
    const decofileParam = url.searchParams.get("__decofile");
    if (decofileParam) {
      decofileOverride = parseJsonRecord(decodeURIComponent(decofileParam));
    }
  }

  if (propsParam && Object.keys(props).length === 0) {
    props = parseJsonRecord(decodeURIComponent(propsParam)) ?? {};
    if (Object.keys(props).length === 0) {
      try {
        props = parseJsonRecord(decodeURIComponent(atob(propsParam))) ?? {};
      } catch {
        // Invalid props remain an empty object.
      }
    }
  }

  if (typeof props.__resolveType === "string" && !component) {
    component = props.__resolveType;
  }

  return { component, props, decofileOverride };
}

function buildPreviewMatcherCtx(request: Request): MatcherContext {
  const url = new URL(request.url);
  const deviceHint = url.searchParams.get("deviceHint");
  const path = url.searchParams.get("path") || "/";

  let userAgent = request.headers.get("user-agent") ?? "";
  if (deviceHint === "mobile" && !/mobile/i.test(userAgent)) {
    userAgent += " Mobile";
  }

  const cookies: Record<string, string> = {};
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key) cookies[key] = value.join("=").trim();
  }

  return {
    userAgent,
    url: url.toString(),
    path,
    cookies,
    request,
  };
}

export async function resolvePreviewRequest(request: Request): Promise<PreviewResolution> {
  const input = await parsePreviewInput(request);

  const resolve = async (): Promise<PreviewResolution> => {
    let { component, props } = input;
    const block = loadBlocks()[component] as Record<string, unknown> | undefined;
    if (block && typeof block.__resolveType === "string") {
      component = block.__resolveType;
      props = { ...block, ...props };
    }

    if (component === WELL_KNOWN_TYPES.PAGE) {
      const resolved = await resolvePageSections(props.sections, buildPreviewMatcherCtx(request));
      const sections = await Promise.all(
        resolved.map((section) => runSingleSectionLoader(section, request).catch(() => section)),
      );
      return { type: "sections", previewType: "page", component, sections };
    }

    if (!getSection(component)) {
      return { type: "unknown", component };
    }

    const resolvedProps = (await resolveValue(props)) as Record<string, unknown>;
    const { __resolveType: _, ...cleanProps } = resolvedProps;
    return {
      type: "sections",
      previewType: "section",
      component,
      sections: [{ component, key: component, props: cleanProps }],
    };
  };

  return input.decofileOverride ? withBlocksOverride(input.decofileOverride, resolve) : resolve();
}
