import { z } from "zod";
import { CHALLENGE_PATTERN, EXCHANGE_CODE_PATTERN, VERIFIER_PATTERN } from "./auth.google.utils.js";

const email = z.email({ message: "A valid email is required" }).trim().toLowerCase();
const password = z
  .string({ message: "Password is required" })
  .min(8, { message: "Password must be at least 8 characters" })
  .max(128, { message: "Password must be at most 128 characters" });

const register = z.object({
  body: z.strictObject({
    name: z.string().trim().min(2, { message: "Name must be at least 2 characters" }).max(100),
    email,
    password,
    phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9\s-]{7,20}$/, { message: "Phone must be 7-20 digits, optionally with +, spaces or dashes" })
      .optional(),
  }),
});

const login = z.object({
  body: z.strictObject({
    email,
    password: z.string({ message: "Password is required" }).min(1, { message: "Password is required" }),
  }),
});

/** Browser navigation: GET /auth/google?challenge=<base64url(SHA-256(verifier))> */
const googleStart = z.object({
  query: z.strictObject({
    challenge: z.string().regex(CHALLENGE_PATTERN, {
      message: "challenge must be base64url(SHA-256(code_verifier)) without padding (43 characters)",
    }),
  }),
});

/** Reached only through Better Auth's redirects; extra params from Better Auth are ignored. */
const googleComplete = z.object({
  query: z.object({
    error: z.string().max(100).optional(),
    new: z.literal("1").optional(),
  }),
});

const googleExchange = z.object({
  body: z.strictObject({
    code: z.string().regex(EXCHANGE_CODE_PATTERN, { message: "Invalid code" }),
    codeVerifier: z.string().regex(VERIFIER_PATTERN, { message: "codeVerifier must be 43-128 characters [A-Za-z0-9-._~]" }),
  }),
});

export const AuthValidation = { register, login, googleStart, googleComplete, googleExchange };

export type RegisterInput = z.infer<typeof register>["body"];
export type LoginInput = z.infer<typeof login>["body"];
export type GoogleStartQuery = z.infer<typeof googleStart>["query"];
export type GoogleCompleteQuery = z.infer<typeof googleComplete>["query"];
export type GoogleExchangeInput = z.infer<typeof googleExchange>["body"];
