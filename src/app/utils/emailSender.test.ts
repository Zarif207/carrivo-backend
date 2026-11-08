import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEmailSender, sanitizeProviderError, type EmailClient, type OutgoingEmail } from "./emailSender.js";

const email: OutgoingEmail = {
  to: "customer@example.com",
  subject: "Carrivo: test",
  text: "hello",
  html: "<p>hello</p>",
  idempotencyKey: "notification/abc",
};

type SendFn = EmailClient["emails"]["send"];
const fakeClient = (send: SendFn): EmailClient & { calls: Parameters<SendFn>[] } => {
  const calls: Parameters<SendFn>[] = [];
  return {
    calls,
    emails: {
      send: (payload, options) => {
        calls.push([payload, options]);
        return send(payload, options);
      },
    },
  };
};

const collectWarnings = () => {
  const warnings: string[] = [];
  return { warnings, warn: (message: string) => warnings.push(message) };
};

describe("createEmailSender (fail-safe)", () => {
  it("returns SENT with the provider id, and passes from, idempotency key and an abort signal", async () => {
    const client = fakeClient(async () => ({ data: { id: "em_123" }, error: null }));
    const { warn } = collectWarnings();
    const sender = createEmailSender({ client, from: "Carrivo <noreply@example.com>", timeoutMs: 1000, warn });
    assert.deepEqual(await sender.send(email), { status: "SENT", providerId: "em_123" });
    const [payload, options] = client.calls[0] ?? [];
    assert.deepEqual(payload, { from: "Carrivo <noreply@example.com>", to: ["customer@example.com"], subject: "Carrivo: test", text: "hello", html: "<p>hello</p>" });
    assert.equal(options?.idempotencyKey, "notification/abc");
    assert.ok(options?.signal instanceof AbortSignal);
  });

  it("returns FAILED (does not throw) when the provider returns an error object", async () => {
    const client = fakeClient(async () => ({ data: null, error: { name: "validation_error", message: "You can only send testing emails to your own email address" } }));
    const result = await createEmailSender({ client, from: "x", timeoutMs: 1000, warn: () => {} }).send(email);
    assert.equal(result.status, "FAILED");
    assert.match(result.status === "FAILED" ? result.error : "", /^validation_error: You can only send/);
  });

  it("returns FAILED (does not throw) when the client throws", async () => {
    const client = fakeClient(async () => {
      throw new TypeError("fetch failed");
    });
    const result = await createEmailSender({ client, from: "x", timeoutMs: 1000, warn: () => {} }).send(email);
    assert.deepEqual(result, { status: "FAILED", error: "TypeError: fetch failed" });
  });

  it("times out, aborts the request and returns FAILED", async () => {
    let aborted = false;
    const client = fakeClient(
      (_payload, options) =>
        new Promise((resolve) => {
          options.signal?.addEventListener("abort", () => {
            aborted = true;
          });
          setTimeout(() => resolve({ data: { id: "late" }, error: null }), 500);
        }),
    );
    const started = Date.now();
    const result = await createEmailSender({ client, from: "x", timeoutMs: 50, warn: () => {} }).send(email);
    assert.deepEqual(result, { status: "FAILED", error: "Timed out after 50 ms" });
    assert.ok(Date.now() - started < 400, "did not wait for the slow provider");
    assert.equal(aborted, true);
  });

  it("returns FAILED when the provider returns no id", async () => {
    const client = fakeClient(async () => ({ data: null, error: null }));
    const result = await createEmailSender({ client, from: "x", timeoutMs: 1000, warn: () => {} }).send(email);
    assert.equal(result.status, "FAILED");
  });

  it("without an API key: SKIPPED every time, warning logged only once, never mentions the address", async () => {
    const { warnings, warn } = collectWarnings();
    const sender = createEmailSender({ client: null, from: "x", timeoutMs: 1000, warn });
    assert.equal(sender.enabled, false);
    assert.equal((await sender.send(email)).status, "SKIPPED");
    assert.equal((await sender.send(email)).status, "SKIPPED");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /RESEND_API_KEY/);
    assert.doesNotMatch(warnings[0] ?? "", /customer@example\.com/);
  });

  it("truncates long provider errors", async () => {
    const client = fakeClient(async () => ({ data: null, error: { message: "x".repeat(2000) } }));
    const result = await createEmailSender({ client, from: "x", timeoutMs: 1000, warn: () => {} }).send(email);
    assert.ok(result.status === "FAILED" && result.error.length <= 300);
  });

  it("removes email addresses from provider errors before they are stored or logged", async () => {
    const message = "You can only send testing emails to your own email address (owner@example.org). Recipient: a.b@example.co.uk";
    const client = fakeClient(async () => ({ data: null, error: { name: "validation_error", message } }));
    const result = await createEmailSender({ client, from: "x", timeoutMs: 1000, warn: () => {} }).send(email);
    assert.equal(result.status === "FAILED" ? result.error : "", "validation_error: You can only send testing emails to your own email address (<email>). Recipient: <email>");
    assert.equal(sanitizeProviderError("no address here\n  at all"), "no address here at all");
  });
});
