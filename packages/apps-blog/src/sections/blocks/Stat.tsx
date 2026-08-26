export type Props = {
  value: string;
  label?: string;
  description?: string;
};

export default function Stat({ value, label, description }: Props) {
  return (
    <div className="flex flex-col items-center text-center py-12 px-8 border-y-2 border-primary/20 my-10">
      <div className="font-display text-[var(--text-5xl)] leading-none text-accent tracking-display tabular-nums">
        {value}
      </div>
      {label && (
        <div className="text-xs font-semibold tracking-caps uppercase text-muted mt-4">{label}</div>
      )}
      {description && (
        <p className="text-sm text-tertiary leading-normal max-w-[40ch] mt-3 [text-wrap:pretty] m-0">
          {description}
        </p>
      )}
    </div>
  );
}
