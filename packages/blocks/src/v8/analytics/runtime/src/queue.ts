import { F_QUEUE_OVERFLOW, LIMITS, WIRE } from "../../shared/contract.ts";

export type QueuedEvent = Record<string, unknown>;

/** Bounded, because a page firing events in a loop must not grow memory in a customer's
 *  browser without limit. Drops the oldest and marks the survivor, so the loss is visible
 *  in the data rather than inferred from a gap. */
export class BoundedQueue {
  private items: QueuedEvent[] = [];

  push(e: QueuedEvent): void {
    if (this.items.length >= LIMITS.queueMax) {
      this.items.shift();
      const t = (e[WIRE._trunc] as string[] | undefined) ?? [];
      if (!t.includes(F_QUEUE_OVERFLOW)) t.push(F_QUEUE_OVERFLOW);
      e[WIRE._trunc] = t;
    }
    this.items.push(e);
  }

  /** Up to `eventsPerBatch` events AND `batchBytes` of them. Fifty `$error`s at 8 KB each is a
   *  400 KB body: the collector answers 413, and keepalive or sendBeacon refuses it outright, so
   *  the whole batch was lost. Always at least one event, so an oversize one cannot wedge the
   *  queue; the collector judges it alone. */
  drain(): QueuedEvent[] {
    let n = 0,
      bytes = 0;
    const enc = new TextEncoder();
    while (n < this.items.length && n < LIMITS.eventsPerBatch) {
      bytes += enc.encode(JSON.stringify(this.items[n])).length + 1;
      if (n && bytes > LIMITS.batchBytes) break;
      n++;
    }
    return this.items.splice(0, n);
  }

  get length(): number {
    return this.items.length;
  }
}
