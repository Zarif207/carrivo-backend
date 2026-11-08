import "dotenv/config";
import { z } from "zod";

const optionalString = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value === "" ? undefined : value));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(5000),

  DATABASE_URL: z.url({ message: "DATABASE_URL must be a valid connection URL" }),
  DIRECT_URL: z.url().optional(),

  // Comma-separated exact origins, e.g. "http://localhost:3000,https://your-frontend.example.com".
  // Each must be a valid http(s) origin; a trailing slash is stripped (it would never match).
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:3000")
    .transform((value, ctx) => {
      const origins: string[] = [];
      for (const raw of value.split(",").map((o) => o.trim()).filter((o) => o.length > 0)) {
        try {
          const url = new URL(raw);
          if ((url.protocol !== "http:" && url.protocol !== "https:") || (url.pathname !== "/" && url.pathname !== "")) {
            throw new Error("not an origin");
          }
          origins.push(url.origin);
        } catch {
          ctx.addIssue({ code: "custom", message: `"${raw}" is not a valid origin (scheme://host[:port], no path)` });
        }
      }
      return origins;
    }),
  // Frontend origin: email links and the Google sign-in landing page are built from it.
  FRONTEND_URL: z
    .url()
    .default("http://localhost:3000")
    .transform((value) => value.replace(/\/+$/, "")),

  BETTER_AUTH_SECRET: z
    .string()
    .min(32, { message: "BETTER_AUTH_SECRET must be at least 32 characters" }),
  BETTER_AUTH_URL: z.url({ message: "BETTER_AUTH_URL must be the API's base URL" }),

  // ── Stripe (test mode in development). Required: payments can't work without them.
  STRIPE_SECRET_KEY: z
    .string()
    .trim()
    .regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/, { message: "STRIPE_SECRET_KEY must be a Stripe secret or restricted key" }),
  STRIPE_WEBHOOK_SECRET: z
    .string()
    .trim()
    .regex(/^whsec_[A-Za-z0-9]+$/, { message: "STRIPE_WEBHOOK_SECRET must be a webhook signing secret (whsec_...)" }),
  // Frontend pages Stripe Checkout redirects to. "?session_id=cs_..." is appended to the success URL.
  FRONTEND_SUCCESS_URL: z.url({ message: "FRONTEND_SUCCESS_URL must be a URL" }),
  FRONTEND_CANCEL_URL: z.url({ message: "FRONTEND_CANCEL_URL must be a URL" }),

  // Shared with the Next.js frontend (its BFF sends it as x-bff-secret with x-client-ip) so rate limits
  // apply per visitor instead of per frontend server. Required in production; see utils/clientKey.ts.
  BFF_SHARED_SECRET: optionalString.pipe(
    z.string().min(32, { message: "BFF_SHARED_SECRET must be at least 32 characters" }).optional(),
  ),

  // Only needed by `npm run db:seed`.
  SEED_DEMO_PASSWORD: optionalString,
  // Optional: a separate password for admin@carrivo.dev (same strength rules; must differ from the demo one).
  SEED_ADMIN_PASSWORD: optionalString,

  // ── Google sign-in (Better Auth social provider). Required.
  GOOGLE_CLIENT_ID: z
    .string()
    .trim()
    .regex(/^[\w.-]+\.apps\.googleusercontent\.com$/, { message: "GOOGLE_CLIENT_ID must be a Google OAuth client id (...apps.googleusercontent.com)" }),
  GOOGLE_CLIENT_SECRET: z.string().trim().min(10, { message: "GOOGLE_CLIENT_SECRET is required" }),

  // Redis is optional: without both values the app runs with no cache and in-memory rate limits.
  UPSTASH_REDIS_REST_URL: optionalString,
  UPSTASH_REDIS_REST_TOKEN: optionalString,
  REDIS_KEY_PREFIX: z.string().trim().min(1).default("carrivo:v1:"),

  // ── Cloudinary (proof-of-delivery images). Required.
  CLOUDINARY_CLOUD_NAME: z.string().trim().min(1, { message: "CLOUDINARY_CLOUD_NAME is required" }),
  CLOUDINARY_API_KEY: z.string().trim().regex(/^\d+$/, { message: "CLOUDINARY_API_KEY must be numeric" }),
  CLOUDINARY_API_SECRET: z.string().trim().min(10, { message: "CLOUDINARY_API_SECRET is required" }),

  // ── Email (Resend). Optional: without a key, notifications are stored but no email is sent.
  RESEND_API_KEY: optionalString.pipe(
    z.string().regex(/^re_[\w-]+$/, { message: "RESEND_API_KEY must be a Resend API key (re_...)" }).optional(),
  ),
  // "Name <address>". onboarding@resend.dev only delivers to your own Resend account address.
  EMAIL_FROM: optionalString.transform((value) => value ?? "Carrivo <onboarding@resend.dev>"),
});

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema
  .superRefine((value, ctx) => {
    if (value.NODE_ENV === "production" && !value.BFF_SHARED_SECRET) {
      ctx.addIssue({ code: "custom", path: ["BFF_SHARED_SECRET"], message: "BFF_SHARED_SECRET is required in production" });
    }
  })
  .safeParse(process.env);

if (!parsed.success) {
  // Only variable names and messages are printed, never values.
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(`Invalid environment variables:\n${issues}`);
}

export const env: Env = parsed.data;
export const isProduction = env.NODE_ENV === "production";
export const isDevelopment = env.NODE_ENV === "development";
/**
 * Stack traces in error responses only for explicit local development. Never on
 * Vercel, even if NODE_ENV is missing there (it defaults to "development").
 */
export const exposeErrorDetails = isDevelopment && !process.env["VERCEL"];
