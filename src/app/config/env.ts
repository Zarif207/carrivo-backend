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

  // Comma-separated exact origins, e.g. "http://localhost:3000,https://carrivo.vercel.app".
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
  FRONTEND_URL: z.url().default("http://localhost:3000"),

  BETTER_AUTH_SECRET: z
    .string()
    .min(32, { message: "BETTER_AUTH_SECRET must be at least 32 characters" }),
  BETTER_AUTH_URL: z.url({ message: "BETTER_AUTH_URL must be the API's base URL" }),

  // Only needed by `npm run db:seed`.
  SEED_DEMO_PASSWORD: optionalString,

  // Later phases: optional until their phase makes them required.
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  STRIPE_SECRET_KEY: optionalString,
  STRIPE_WEBHOOK_SECRET: optionalString,
  STRIPE_SUCCESS_URL: optionalString,
  STRIPE_CANCEL_URL: optionalString,
  // Redis is optional: without both values the app runs with no cache and in-memory rate limits.
  UPSTASH_REDIS_REST_URL: optionalString,
  UPSTASH_REDIS_REST_TOKEN: optionalString,
  REDIS_KEY_PREFIX: z.string().trim().min(1).default("carrivo:v1:"),
  CLOUDINARY_CLOUD_NAME: optionalString,
  CLOUDINARY_API_KEY: optionalString,
  CLOUDINARY_API_SECRET: optionalString,
  EMAIL_FROM: optionalString,
});

export type Env = z.infer<typeof envSchema>;

const parsed = envSchema.safeParse(process.env);

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
