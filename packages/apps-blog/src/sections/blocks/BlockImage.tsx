export type Props = {
  url: string;
  alt?: string;
  caption?: string;
  size?: "full" | "normal";
};

export default function BlockImage({ url, alt, caption, size }: Props) {
  const wrapperClass = size === "full" ? "my-8 -mx-[var(--gutter)]" : "my-8";

  return (
    <figure className={wrapperClass}>
      <div className="overflow-hidden bg-alt">
        <img src={url} alt={alt ?? ""} loading="lazy" className="w-full h-auto block" />
      </div>
      {caption && (
        <figcaption className="text-sm text-tertiary text-center mt-3 italic">{caption}</figcaption>
      )}
    </figure>
  );
}
