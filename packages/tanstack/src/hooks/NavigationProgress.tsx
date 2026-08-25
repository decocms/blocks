import { useRouterState } from "@tanstack/react-router";

const PROGRESS_CSS = `
@keyframes progressSlide { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
.nav-progress-bar { animation: progressSlide 1s ease-in-out infinite; }
`;

export interface NavigationProgressProps {
	/**
	 * Bar color. Any CSS color. Defaults to `currentColor`, so the bar inherits
	 * the text color of wherever it is mounted.
	 *
	 * Deliberately NOT a Tailwind utility class: this is framework code, and a
	 * utility like `bg-brand-primary-500` is only emitted if the consuming site
	 * happens to define that token. On a Tailwind v4 theme that resets
	 * `--color-*: initial`, the class is never generated and the bar renders
	 * fully transparent — an invisible progress indicator, in production, with
	 * no build error. Inline styles cannot fail that way.
	 */
	color?: string;
}

/**
 * Top-of-page loading bar that appears during SPA navigation.
 * Uses the router's isLoading state — no extra dependencies.
 */
export function NavigationProgress({ color = "currentColor" }: NavigationProgressProps = {}) {
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
