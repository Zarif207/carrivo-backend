/**
 * Fail-safe email sending. `send` NEVER throws and never waits longer than
 * `timeoutMs`: every outcome (sent, provider error, network error, timeout, no
 * API key) is returned as a value for the caller to record.
 *
 * The client is the subset of the Resend SDK we use, so tests pass a fake.
 */
export interface EmailClient {
  emails: {
    send(
      payload: { from: string; to: string[]; subject: string; text: string; html: string },
      options: { idempotencyKey?: string; signal?: AbortSignal },
    ): Promise<{ data: { id: string } | null; error: { message: string; name?: string } | null }>;
  };
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Same key → Resend sends at most once within 24 h. */
  idempotencyKey: string;
}

export type SendResult =
  | { status: "SENT"; providerId: string }
  | { status: "FAILED"; error: string }
  | { status: "SKIPPED"; reason: string };

export interface EmailSenderOptions {
  /** null when RESEND_API_KEY is not configured. */
  client: EmailClient | null;
  from: string;
  timeoutMs: number;
  /** Logging hook; messages never contain addresses, keys or content. */
  warn: (message: string) => void;
}

const MAX_ERROR_LENGTH = 300;

const EMAIL_ADDRESS = /[^\s@()<>"',;:]+@[^\s@()<>"',;:]+\.[A-Za-z]{2,}/g;

/**
 * Stored/logged error text: single line, truncated, and with every email address
 * replaced (provider messages can name the recipient or the account owner).
 */
export const sanitizeProviderError = (message: string): string =>
  message.replace(EMAIL_ADDRESS, "<email>").replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_LENGTH);

const short = sanitizeProviderError;

export const createEmailSender = ({ client, from, timeoutMs, warn }: EmailSenderOptions) => {
  let warnedDisabled = false;

  const send = async (email: OutgoingEmail): Promise<SendResult> => {
    if (!client) {
      if (!warnedDisabled) {
        warnedDisabled = true;
        warn("[email] RESEND_API_KEY is not set: notifications are stored but no emails are sent.");
      }
      return { status: "SKIPPED", reason: "Email is not configured (RESEND_API_KEY unset)" };
    }

    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<SendResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ status: "FAILED", error: `Timed out after ${timeoutMs} ms` });
      }, timeoutMs);
    });

    const attempt = (async (): Promise<SendResult> => {
      try {
        const { data, error } = await client.emails.send(
          { from, to: [email.to], subject: email.subject, text: email.text, html: email.html },
          { idempotencyKey: email.idempotencyKey, signal: controller.signal },
        );
        if (error) return { status: "FAILED", error: short(`${error.name ? `${error.name}: ` : ""}${error.message}`) };
        if (!data?.id) return { status: "FAILED", error: "Provider returned no message id" };
        return { status: "SENT", providerId: data.id };
      } catch (error) {
        return { status: "FAILED", error: short(error instanceof Error ? `${error.name}: ${error.message}` : "Unknown error") };
      }
    })();

    try {
      return await Promise.race([attempt, timeout]);
    } finally {
      clearTimeout(timer);
    }
  };

  return { send, enabled: client !== null };
};

export type EmailSender = ReturnType<typeof createEmailSender>;
