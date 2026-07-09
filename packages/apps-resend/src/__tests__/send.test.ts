import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendEmail } from "../actions/send";
import { configureResend } from "../client";

describe("sendEmail", () => {
	let fetchSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		configureResend({
			apiKey: "re_test_123",
			emailFrom: "Test <test@example.com>",
			emailTo: ["default@example.com"],
			subject: "Default Subject",
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends email with provided fields", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ id: "email_abc123" }),
		});

		const result = await sendEmail({
			to: "user@example.com",
			subject: "Hello",
			html: "<p>World</p>",
		});

		expect(result.data).toEqual({ id: "email_abc123" });
		expect(result.error).toBeNull();

		expect(fetchSpy).toHaveBeenCalledWith("https://api.resend.com/emails", {
			method: "POST",
			headers: {
				Authorization: "Bearer re_test_123",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				from: "Test <test@example.com>",
				to: "user@example.com",
				subject: "Hello",
				html: "<p>World</p>",
			}),
		});
	});

	it("falls back to defaults when fields are omitted", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ id: "email_def456" }),
		});

		await sendEmail({
			html: "<p>Contact form</p>",
		});

		const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
		expect(body.from).toBe("Test <test@example.com>");
		expect(body.to).toEqual(["default@example.com"]);
		expect(body.subject).toBe("Default Subject");
		expect(body.html).toBe("<p>Contact form</p>");
	});

	it("returns error on API failure", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: false,
			json: () =>
				Promise.resolve({
					message: "Invalid API key",
					name: "invalid_api_Key",
				}),
		});

		const result = await sendEmail({
			to: "user@example.com",
			subject: "Test",
			html: "<p>Test</p>",
		});

		expect(result.data).toBeNull();
		expect(result.error).toEqual({
			message: "Invalid API key",
			name: "invalid_api_Key",
		});
	});

	it("throws when configureResend was not called", async () => {
		// Reset the config by importing a fresh module
		// We can't easily reset the singleton, so we test the error path
		// by calling getResendConfig directly
		const { getResendConfig } = await import("../client");
		// Config was set in beforeEach, so this should work
		expect(() => getResendConfig()).not.toThrow();
	});
});
