/**
 * The v8 Resend client (/next/upstream-clients): one typed call through the
 * instrumented fetch, errors without bodies or keys, no retries.
 */
import { describe, expect, it, vi } from "vitest";
import { createResendClient, ResendError } from "../index";

function fakeFetch(status: number, body: unknown) {
  return vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status }),
  );
}

const email = {
  from: "Store <hello@example.com>",
  to: "shopper@example.com",
  subject: "Your order",
  html: "<p>Thanks</p>",
};

describe("createResendClient", () => {
  it("sendEmail posts the email with the API key and returns its id", async () => {
    const fetch = fakeFetch(200, { id: "email_1" });
    const resend = createResendClient({ apiKey: "re_test" }, { fetch });

    await expect(resend.sendEmail(email)).resolves.toEqual({ id: "email_1" });

    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://api.resend.com/emails");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ authorization: "Bearer re_test" });
    expect(JSON.parse(String(init?.body))).toEqual(email);
  });

  it("throws the operation and status, never the body or the key", async () => {
    const fetch = fakeFetch(422, { name: "validation_error", message: "re_test is bad" });
    const resend = createResendClient({ apiKey: "re_test" }, { fetch });

    const error = await resend.sendEmail(email).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ResendError);
    expect(error).toMatchObject({ operation: "sendEmail", status: 422 });
    expect((error as Error).message).not.toContain("re_test");
  });

  it("does not retry", async () => {
    const fetch = fakeFetch(503, {});
    const resend = createResendClient({ apiKey: "re_test" }, { fetch });

    await expect(resend.sendEmail(email)).rejects.toThrow(ResendError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
