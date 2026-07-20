import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createResilientFetch,
  isNonRetryableVtexError,
  resetResilienceState,
  VtexCircuitOpenError,
  VtexTimeoutError,
} from "../resilience";

function res(status: number, body = "ok"): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  resetResilienceState();
});

describe("createResilientFetch", () => {
  it("passes a healthy GET through untouched, no retry", async () => {
    const underlying = vi.fn(async () => res(200, "prod"));
    const rf = createResilientFetch(underlying as unknown as typeof fetch);
    const r = await rf("https://acct.vtexcommercestable.com.br/ok");
    expect(r.status).toBe(200);
    expect(underlying).toHaveBeenCalledOnce();
  });

  it("never retries a POST (mutation), even on 5xx", async () => {
    const underlying = vi.fn(async () => res(500));
    const rf = createResilientFetch(underlying as unknown as typeof fetch);
    const r = await rf("https://acct.vtexcommercestable.com.br/checkout", {
      method: "POST",
      body: "{}",
    });
    expect(r.status).toBe(500);
    expect(underlying).toHaveBeenCalledOnce();
  });

  it("retries an idempotent GET on a thrown network error, then succeeds", async () => {
    let n = 0;
    const underlying = vi.fn(async () => {
      n++;
      if (n < 3) throw new Error("ECONNRESET");
      return res(200);
    });
    const rf = createResilientFetch(underlying as unknown as typeof fetch, {
      backoffBaseMs: 1,
      backoffCapMs: 2,
    });
    const r = await rf("https://acct.vtexcommercestable.com.br/search");
    expect(r.status).toBe(200);
    expect(underlying).toHaveBeenCalledTimes(3);
  });

  it("opens the circuit after N consecutive failures and then fails fast", async () => {
    const underlying = vi.fn(async () => res(503));
    const rf = createResilientFetch(underlying as unknown as typeof fetch, {
      breakerConsecutiveFailures: 5,
    });
    const host = "https://acct.vtexcommercestable.com.br";
    // 5 POSTs (1 attempt each) → 5 consecutive breaker failures → open.
    for (let i = 0; i < 5; i++) {
      await rf(`${host}/p`, { method: "POST", body: "x" });
    }
    const before = underlying.mock.calls.length;
    await expect(rf(`${host}/p`, { method: "POST", body: "x" })).rejects.toBeInstanceOf(
      VtexCircuitOpenError,
    );
    // Fail-fast must not touch the origin.
    expect(underlying.mock.calls.length).toBe(before);
  });

  it("half-opens after cooldown and closes on a successful probe", async () => {
    vi.useFakeTimers();
    try {
      let healthy = false;
      const underlying = vi.fn(async () => (healthy ? res(200) : res(503)));
      const rf = createResilientFetch(underlying as unknown as typeof fetch, {
        breakerConsecutiveFailures: 3,
        breakerOpenCooldownMs: 5_000,
      });
      const host = "https://acct.vtexcommercestable.com.br";
      for (let i = 0; i < 3; i++) await rf(`${host}/p`, { method: "POST", body: "x" });
      // Open now → fail fast.
      await expect(rf(`${host}/p`, { method: "POST", body: "x" })).rejects.toBeInstanceOf(
        VtexCircuitOpenError,
      );
      // After cooldown, a probe is allowed; make it succeed.
      healthy = true;
      await vi.advanceTimersByTimeAsync(5_001);
      const r = await rf(`${host}/p`, { method: "POST", body: "x" });
      expect(r.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a hung request with the per-attempt timeout", async () => {
    vi.useFakeTimers();
    try {
      const underlying = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            );
          }),
      );
      const rf = createResilientFetch(underlying as unknown as typeof fetch, {
        maxRetries: 0,
        perAttemptTimeoutMs: 8_000,
      });
      const p = rf("https://acct.vtexcommercestable.com.br/hung");
      p.catch(() => {});
      await vi.advanceTimersByTimeAsync(8_001);
      await expect(p).rejects.toBeInstanceOf(VtexTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors the kill-switch env var", async () => {
    const prev = process.env.VTEX_RESILIENCE_DISABLED;
    process.env.VTEX_RESILIENCE_DISABLED = "true";
    try {
      const underlying = vi.fn(async () => res(200));
      const rf = createResilientFetch(underlying as unknown as typeof fetch);
      await rf("https://acct.vtexcommercestable.com.br/x", { method: "POST", body: "y" });
      expect(underlying).toHaveBeenCalledOnce();
    } finally {
      if (prev === undefined) delete process.env.VTEX_RESILIENCE_DISABLED;
      else process.env.VTEX_RESILIENCE_DISABLED = prev;
    }
  });
});

describe("isNonRetryableVtexError", () => {
  it("flags circuit-open and timeout errors, not generic ones", () => {
    expect(isNonRetryableVtexError(new VtexCircuitOpenError("h"))).toBe(true);
    expect(isNonRetryableVtexError(new VtexTimeoutError("h", 1))).toBe(true);
    expect(isNonRetryableVtexError(new Error("boom"))).toBe(false);
    expect(isNonRetryableVtexError(null)).toBe(false);
  });
});
