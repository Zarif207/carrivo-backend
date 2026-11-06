import { Resend } from "resend";
import { env } from "../config/env.js";
import { createEmailSender } from "../utils/emailSender.js";

/** Per email; the request never waits for it (sent after the response, see NotificationService). */
export const EMAIL_TIMEOUT_MS = 5_000;

export const emailSender = createEmailSender({
  client: env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null,
  from: env.EMAIL_FROM,
  timeoutMs: EMAIL_TIMEOUT_MS,
  warn: (message) => console.warn(message),
});
