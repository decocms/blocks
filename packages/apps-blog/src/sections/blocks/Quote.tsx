export type Props = {
  quote?: string;
  text?: string;
  attribution?: string;
  source?: string;
};

export default function Quote({ quote, text, attribution, source }: Props) {
  return (
    <blockquote className="relative px-10 py-10 sm:px-12 sm:py-12 bg-alt border-l-4 border-accent rounded-brand my-10 overflow-hidden">
      {/* oversized decorative quotation mark */}
      <span
        className="pointer-events-none select-none absolute bottom-[-0.45em] right-10 font-display text-[20rem] sm:text-[28rem] leading-none text-accent opacity-[0.07]"
        aria-hidden="true"
      >
        &ldquo;
      </span>

      <p className="relative font-display text-[var(--text-xl)] sm:text-[var(--text-2xl)] italic leading-snug m-0 [text-wrap:pretty]">
        {quote ?? text}
      </p>

      {(attribution || source) && (
        <footer className="relative mt-5 text-sm text-tertiary not-italic flex items-center gap-1.5">
          <span className="block w-5 h-px bg-current opacity-50" aria-hidden="true" />
          {attribution && <cite className="not-italic">{attribution}</cite>}
          {source && <span>{source}</span>}
        </footer>
      )}
    </blockquote>
  );
}
