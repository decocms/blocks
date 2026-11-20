import { describe, expect, it } from "vitest";
import { createFetchCache } from "./fetchCache";
import { RequestContext } from "./requestContext";

/*
  Produção (farmrio, 24h): ~14k "Network connection lost." espalhados pelas rotas de render.
  O fetch da VTEX herda o abort da request que o INICIOU (RequestContext.signal), e o
  fetchCache compartilha esse fetch entre requests. Cliente da dona desconecta → o fetch
  compartilhado aborta → toda request que entrou no dedup recebia o erro da dona.
*/
describe("fetch compartilhado quando a dona é cancelada", () => {
  it("quem entrou junto e continua conectado recebe o dado, não o abort da dona", async () => {
    const cache = createFetchCache({
      provider: "test-owner-abort",
      maxEntries: 10,
      freshTtlMs: { success: 60_000, notFound: 0, serverError: 0 },
      staleIfErrorMs: 0,
      inflightBackstopMs: 5_000,
    });
    let calls = 0;
    // Igual ao resilientFetch: o fetch obedece o sinal da request ambiente.
    const doFetch = () => {
      calls++;
      const signal = RequestContext.current?.signal;
      return new Promise<Response>((resolve, reject) => {
        const t = setTimeout(() => resolve(Response.json({ ok: true })), 50);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    };

    const ownerClient = new AbortController();
    const owner = RequestContext.run(
      new Request("https://s.test/a", { signal: ownerClient.signal }),
      () => cache.fetchWithCache("https://vtex.test/search?q=x", doFetch),
    );
    const joiner = RequestContext.run(new Request("https://s.test/b"), () =>
      cache.fetchWithCache("https://vtex.test/search?q=x", doFetch),
    );
    ownerClient.abort();

    await expect(owner).rejects.toThrow(/aborted/);
    await expect(joiner).resolves.toEqual({ ok: true });
    expect(calls).toBe(2); // a dona + uma refeita pela request que ficou
  });

  it("quem entrou junto e TAMBÉM foi cancelado não refaz o trabalho", async () => {
    const { joinInflight } = await import("./inflightTimeout");
    const mine = new AbortController();
    mine.abort();
    let retried = false;
    const shared = Promise.reject(new DOMException("aborted", "AbortError"));
    const p = RequestContext.run(new Request("https://s.test/c", { signal: mine.signal }), () =>
      joinInflight(shared, async () => {
        retried = true;
        return 1;
      }),
    );
    await expect(p).rejects.toThrow(/aborted/);
    expect(retried).toBe(false);
  });

  it("erro de verdade do upstream continua sendo repassado", async () => {
    const { joinInflight } = await import("./inflightTimeout");
    let retried = false;
    const p = RequestContext.run(new Request("https://s.test/d"), () =>
      joinInflight(Promise.reject(new Error("VTEX 500")), async () => {
        retried = true;
        return 1;
      }),
    );
    await expect(p).rejects.toThrow("VTEX 500");
    expect(retried).toBe(false);
  });
});
