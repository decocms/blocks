import { LIVE_CONTROLS_SCRIPT, resolvePreviewRequest } from "@decocms/blocks-admin";
import { getPreviewWrapper, getRenderShellConfig } from "@decocms/blocks-admin/admin/setup";
import { headers } from "next/headers";
import { cloneElement, createElement, type ReactElement, type ReactNode } from "react";
import { SectionRenderer } from "./SectionRenderer";

export interface CreateDecoPreviewPageOptions {
  setup?: () => Promise<void>;
}

export interface DecoPreviewPageProps {
  params: Promise<{ path?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function appendSearchParams(
  target: URLSearchParams,
  source: Record<string, string | string[] | undefined>,
) {
  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      for (const item of value) target.append(key, item);
    } else if (value !== undefined) {
      target.set(key, value);
    }
  }
}

async function buildPreviewRequest(props: DecoPreviewPageProps): Promise<Request> {
  const [params, searchParams, requestHeaders] = await Promise.all([
    props.params,
    props.searchParams,
    headers(),
  ]);
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  const encodedPath = (params.path ?? []).map(encodeURIComponent).join("/");
  const url = new URL(`/live/previews/${encodedPath}`, `${protocol}://${host}`);
  appendSearchParams(url.searchParams, searchParams);
  return new Request(url, { headers: new Headers(requestHeaders) });
}

function PreviewResources() {
  const { cssHref, fontHrefs } = getRenderShellConfig();
  return (
    <>
      {fontHrefs.map((href) => (
        <link key={href} rel="stylesheet" href={href} />
      ))}
      {cssHref ? <link rel="stylesheet" href={cssHref} /> : null}
    </>
  );
}

function PreviewFrame({ children }: { children: ReactNode }) {
  const { themeName, bodyClass } = getRenderShellConfig();
  const Wrapper = getPreviewWrapper();
  const content = Wrapper ? createElement(Wrapper, null, children) : children;

  return (
    <>
      <PreviewResources />
      <div data-theme={themeName || "light"} className={bodyClass || undefined}>
        {content}
      </div>
      <script dangerouslySetInnerHTML={{ __html: LIVE_CONTROLS_SCRIPT }} />
    </>
  );
}

function PreviewDiagnostic({ children }: { children: ReactNode }) {
  return <div style={{ padding: 20, color: "red" }}>{children}</div>;
}

export function createDecoPreviewPage(options: CreateDecoPreviewPageOptions = {}) {
  return async function DecoPreviewPage(props: DecoPreviewPageProps) {
    await options.setup?.();

    try {
      const request = await buildPreviewRequest(props);
      const resolution = await resolvePreviewRequest(request);
      if (resolution.type === "unknown") {
        return (
          <PreviewFrame>
            <PreviewDiagnostic>{`Unknown section: ${resolution.component}`}</PreviewDiagnostic>
          </PreviewFrame>
        );
      }

      const rendered = await Promise.all(
        resolution.sections.map(async (section, index): Promise<ReactElement | null> => {
          const element = await SectionRenderer({ resolved: section });
          return element
            ? cloneElement(element, { key: `${section.key}-${section.index ?? index}` })
            : null;
        }),
      );

      return <PreviewFrame>{rendered}</PreviewFrame>;
    } catch (error) {
      return (
        <PreviewFrame>
          <PreviewDiagnostic>{`Render error: ${(error as Error).message}`}</PreviewDiagnostic>
        </PreviewFrame>
      );
    }
  };
}
