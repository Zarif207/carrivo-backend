import { z } from "zod";

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

export const AuthValidation = { register, login };

export type RegisterInput = z.infer<typeof register>["body"];
export type LoginInput = z.infer<typeof login>["body"];
