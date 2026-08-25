import { useRouterState } from "@tanstack/react-router";

const PROGRESS_CSS = `
@keyframes progressSlide { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
.nav-progress-bar { animation: progressSlide 1s ease-in-out infinite; }
`;

/**
 * Brand token when the site defines it, inherited text color when it does not.
 *
 * The bar used to be painted with the Tailwind utility `bg-brand-primary-500`.
 * That token is a *site* concern, and framework code cannot assume it exists: on
 * a Tailwind v4 theme that resets `--color-*: initial` the utility is never
 * generated, so the class resolved to nothing and the bar rendered fully
 * transparent — an invisible progress indicator, in production, with no build
 * error and nothing in the console.
 *
 * A CSS custom property with a fallback fixes that without regressing the sites
 * where it already worked: they keep their brand color (Tailwind v4 emits
 * `--color-brand-primary-500` for a `brand-primary` palette entry), and
 * everyone else falls back to `currentColor` instead of nothing. Unlike a
 * utility class, neither half can be dropped by a CSS build.
 */
const DEFAULT_COLOR = "var(--color-brand-primary-500, currentColor)";

export interface NavigationProgressProps {
	/**
	 * Bar color. Any CSS color or custom-property expression. Defaults to
	 * {@link DEFAULT_COLOR} — the site's `brand-primary-500` token when defined,
	 * otherwise the inherited text color. Pass an explicit value to brand the bar
	 * without relying on that token name.
	 */
	color?: string;
}

/**
 * Top-of-page loading bar that appears during SPA navigation.
 * Uses the router's isLoading state — no extra dependencies.
 */
export function NavigationProgress({ color = DEFAULT_COLOR }: NavigationProgressProps = {}) {
	const isLoading = useRouterState({ select: (s) => s.isLoading });
	if (!isLoading) return null;
	return (
		<div
			className="fixed top-0 left-0 right-0 z-[9999] h-1 overflow-hidden"
			style={{ color }}
			role="progressbar"
			aria-label="Carregando página"
		>
			<style dangerouslySetInnerHTML={{ __html: PROGRESS_CSS }} />
			{/* Track and bar are siblings so the track's 20% alpha does not
			    inherit onto the bar (opacity applies to the whole subtree). */}
			<div
				className="absolute inset-0"
				style={{ backgroundColor: "currentColor", opacity: 0.2 }}
			/>
			<div
				className="nav-progress-bar absolute inset-y-0 left-0 w-1/3 rounded-full"
				style={{ backgroundColor: "currentColor" }}
			/>
		</div>
	);
}
