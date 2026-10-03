/** `always`: the fallback rule. */
export const always = (): boolean => true;

/** `never`: the rule the site editor uses to hide a block. */
export const never = (): boolean => false;

/** Inputs of the built-in `date` matcher: ISO 8601 strings, both optional. */
interface DateProps {
  /** Inclusive. */
  start?: string;
  /** Exclusive: `end` itself doesn't match. */
  end?: string;
}

/**
 * `date`: `true` from `start` (inclusive) until `end` (exclusive). A date
 * without a time means midnight UTC. An unparseable bound never matches, so a
 * typo can't switch a campaign on.
 */
export const date = ({ start, end }: DateProps = {}): boolean => {
  const now = Date.now();
  if (start !== undefined && start !== null && start !== "") {
    const from = Date.parse(start);
    if (Number.isNaN(from) || now < from) return false;
  }
  if (end !== undefined && end !== null && end !== "") {
    const until = Date.parse(end);
    if (Number.isNaN(until) || now >= until) return false;
  }
  return true;
};
