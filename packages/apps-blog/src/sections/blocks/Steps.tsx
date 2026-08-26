import { sanitizeHtml } from "../../utils/sanitizeHtml";

type Step = { title: string; description?: string };

export type Props = {
  title?: string;
  /** JSON-encoded Step[] */
  steps: string;
};

export default function Steps({ title, steps }: Props) {
  let list: Step[] = [];
  try {
    const parsed = JSON.parse(steps ?? "[]");
    if (Array.isArray(parsed)) list = parsed;
  } catch {
    /* ignore */
  }

  return (
    <div className="my-8">
      {title && (
        <h3 className="font-display text-xl font-semibold uppercase tracking-snug mb-6">{title}</h3>
      )}
      <ol className="list-none p-0 m-0 flex flex-col">
        {list.map((step, i) => (
          <li key={i} className="grid grid-cols-[48px_1fr] gap-5 pb-8 relative">
            {/* connector line — -bottom-8 matches the pb-8 gap so the line bridges into the next step's number box */}
            {i < list.length - 1 && (
              <span
                className="absolute left-6 -translate-x-1/2 top-12 -bottom-8 w-px bg-accent z-0"
                aria-hidden="true"
              />
            )}

            {/* number box */}
            <div
              className="relative z-[1] w-12 h-12 flex-shrink-0 flex items-center justify-center border-2 border-accent bg-base text-accent font-semibold text-lg leading-none"
              aria-hidden="true"
            >
              {i + 1}
            </div>

            {/* content */}
            <div className="min-w-0 pt-2.5">
              <strong
                className="font-semibold leading-snug block mb-1.5 [&_a]:text-inherit [&_a]:no-underline"
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(step.title) }}
              />
              {step.description && (
                <p
                  className="text-sm leading-normal m-0 [&_a]:text-accent [&_a]:underline"
                  dangerouslySetInnerHTML={{
                    __html: sanitizeHtml(step.description),
                  }}
                />
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
