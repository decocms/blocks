import { sanitizeHtml } from "../../utils/sanitizeHtml";

export type Props = {
  title?: string;
  /** JSON-encoded string[] */
  items: string;
};

export default function Checklist({ title, items }: Props) {
  let list: string[] = [];
  try {
    const parsed = JSON.parse(items ?? "[]");
    if (Array.isArray(parsed)) list = parsed;
  } catch {
    /* ignore */
  }

  return (
    <div className="my-6">
      {title && (
        <h3 className="font-display text-[var(--text-xl)] font-normal tracking-snug mb-4">
          {title}
        </h3>
      )}
      <ul className="list-none p-0 m-0">
        {list.map((item, i) => (
          <li
            key={i}
            className="flex items-start gap-3 py-3.5 border-b border-line-subtle first:border-t first:border-line-subtle"
          >
            <span
              className="flex-shrink-0 w-5 h-5 flex items-center justify-center text-accent mt-[1px]"
              aria-hidden="true"
            >
              <svg
                aria-hidden="true"
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>
            <span
              className="text-[1.0625rem] leading-normal [&_a]:text-accent [&_strong]:font-semibold [&_strong]:text-base"
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(item) }}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
