/**
 * The site itself, embedded — and the bridge back to native.
 *
 * This is what makes the hybrid worth shipping on day one: every page the app
 * has no native screen for still works, including a page published after the
 * binary shipped. `createRoutePolicy` decides which is which; this renders the
 * rest.
 *
 * Without the bridge back, the two halves are islands: a tap inside the WebView
 * stays inside the WebView, with the native screen sitting unused next to it.
 * `onShouldStartLoadWithRequest` cancels the navigation and pushes the native
 * route instead — so promoting a route changes every link at once, and no
 * section has to know which is which.
 *
 * `react-native-webview` is an optional peer: an app that only renders native
 * screens should not pay for it. Passing `WebViewComponent` keeps the import
 * in the consumer, where the bundler can see it.
 */

import { type ComponentType, type ReactElement } from "react";

/** The subset of `react-native-webview`'s props this component drives. */
export interface WebViewLike {
  source: { uri: string };
  style?: unknown;
  sharedCookiesEnabled?: boolean;
  injectedJavaScriptBeforeContentLoaded?: string;
  onMessage?: (event: { nativeEvent: { data: string } }) => void;
  onShouldStartLoadWithRequest?: (request: { url: string }) => boolean;
}

/**
 * Hides the site's own header and footer inside the WebView.
 *
 * Injection rather than a CMS variant, deliberately: a variant is per page
 * block, so configuring it means editing every page — and a page published
 * tomorrow is born without it. This does not scale.
 *
 * The selector is `data-manifest-key`, which the framework emits on EVERY
 * section (`DecoPageRenderer`), so it is a contract rather than a brittle CSS
 * class: it holds for any page, present or future, with nothing touched in the
 * CMS.
 *
 * The `app` variant still matters for `?renderJson`, where the app does not
 * want to RECEIVE those sections at all. This is about not rendering what
 * already arrived.
 */
const hideChrome = (selectors: string[]) => `
  (function () {
    var css = ${JSON.stringify(selectors.map((s) => `[data-manifest-key$="${s}"]`).join(","))} + "{display:none!important}";
    var tag = document.createElement("style");
    tag.appendChild(document.createTextNode(css));
    document.head.appendChild(tag);
  })();
  true;
`;

/**
 * Reports back into React Native what the WebView did.
 *
 * Two things are invisible from outside the WebView, and both cost real
 * debugging time before this existed:
 *
 * 1. **Errors.** A JS error inside the WebView reaches no log — not Metro, not
 *    the server, which only sees successful requests. `window.onerror` alone
 *    reports `Script error.` with no file and no line.
 * 2. **Mutations.** Native has no way to know a page changed the cart: there is
 *    no event, and the native query only revalidates when its staleTime
 *    expires. So the badge sits still even with a shared session.
 *
 * The serverFn target arrives base64-encoded in the path (file + export), so
 * what was called can be identified without coupling to route names or to a
 * build-generated hash.
 */
const instrument = (mutationPattern: string) => `
  (function () {
    var post = function (payload) {
      try { window.ReactNativeWebView.postMessage(JSON.stringify(payload)); } catch (e) {}
    };
    var send = function (level, args) {
      post({ __decoLog: true, level: level, text: Array.prototype.map.call(args, function (a) {
        if (a instanceof Error) return a.message + " | " + a.stack;
        try { return typeof a === "string" ? a : JSON.stringify(a); } catch (e) { return String(a); }
      }).join(" ") });
    };
    ["log", "warn", "error"].forEach(function (level) {
      var original = console[level];
      console[level] = function () { send(level, arguments); original.apply(console, arguments); };
    });
    window.addEventListener("error", function (e) {
      send("error", [e.message + " @ " + e.filename + ":" + e.lineno]);
    });
    window.addEventListener("unhandledrejection", function (e) { send("error", ["unhandled: ", e.reason]); });

    var mutates = new RegExp(${JSON.stringify(mutationPattern)}, "i");
    var originalFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var method = ((init && init.method) || "GET").toUpperCase();
      return originalFetch.apply(this, arguments).then(function (res) {
        if (res.ok && method === "POST") {
          var target = url;
          try {
            var seg = url.split("/_serverFn/")[1];
            if (seg) target = atob(seg.split("?")[0].replace(/-/g, "+").replace(/_/g, "/"));
          } catch (e) {}
          if (mutates.test(target)) post({ __decoMutation: true, target: target });
        }
        return res;
      });
    };
  })();
  true;
`;

export interface SiteViewProps {
  /** `react-native-webview`'s `WebView`. Passed in so the import stays local. */
  WebViewComponent: ComponentType<WebViewLike>;
  /** Origin of the deployed site. */
  baseUrl: string;
  /** Path to open. @default "/" */
  path?: string;
  /**
   * Resolves a site path to a native route, or reports that there is none.
   * Pass `routes.resolve` from `createRoutePolicy`.
   */
  resolve?: (path: string) => { kind: string; route: string };
  /** Called with the native route when a link should leave the WebView. */
  onNavigateNative?: (route: string) => void;
  /**
   * Adds `?app=1` so the CMS's `app` variant applies. Only useful once the
   * site actually declares one.
   * @default true
   */
  asApp?: boolean;
  /** Section suffixes to hide. @default Header and Footer */
  hideSections?: string[];
  /** Fired when a page mutated shared state — invalidate the native query. */
  onMutation?: (target: string) => void;
  /** Fired for every console call inside the WebView. */
  onLog?: (level: string, text: string) => void;
  /** Which serverFn/invoke targets count as a mutation. @default cart|checkout */
  mutationPattern?: string;
  style?: unknown;
}

export function SiteView({
  WebViewComponent,
  baseUrl,
  path = "/",
  resolve,
  onNavigateNative,
  asApp = true,
  hideSections = ["Header/Header.tsx", "Footer/Footer.tsx"],
  onMutation,
  onLog,
  mutationPattern = "cart|checkout",
  style,
}: SiteViewProps): ReactElement {
  const url = new URL(path, baseUrl);
  if (asApp) url.searchParams.set("app", "1");
  const uri = url.toString();

  return (
    <WebViewComponent
      source={{ uri }}
      style={style ?? { flex: 1 }}
      // Shares the session between WebViews. The native `fetch` sits outside it
      // unless the cookie jar is given a `SystemCookieStore` — without that,
      // native and embedded pages read different carts.
      sharedCookiesEnabled
      injectedJavaScriptBeforeContentLoaded={
        instrument(mutationPattern) + hideChrome(hideSections)
      }
      onMessage={(event) => {
        let data: { __decoLog?: boolean; __decoMutation?: boolean; level?: string; text?: string; target?: string };
        try {
          data = JSON.parse(event.nativeEvent.data);
        } catch {
          // Not ours — a site may postMessage for its own reasons.
          return;
        }
        if (data.__decoLog) onLog?.(data.level ?? "log", data.text ?? "");
        if (data.__decoMutation) onMutation?.(data.target ?? "");
      }}
      onShouldStartLoadWithRequest={(request) => {
        if (request.url === uri || !request.url.startsWith(baseUrl)) return true;
        if (!resolve || !onNavigateNative) return true;
        const target = resolve(new URL(request.url).pathname);
        if (target.kind !== "native") return true;
        onNavigateNative(target.route);
        return false;
      }}
    />
  );
}
