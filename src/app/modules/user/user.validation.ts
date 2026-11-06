import { z } from "zod";

const updateMe = z.object({
  body: z
    .strictObject({
      name: z.string().trim().min(2, { message: "Name must be at least 2 characters" }).max(100),
      phone: z
        .string()
        .trim()
        .regex(/^\+?[0-9\s-]{7,20}$/, { message: "Phone must be 7-20 digits, optionally with +, spaces or dashes" })
        .nullable(),
      address: z.string().trim().min(3).max(300).nullable(),
      image: z.url({ message: "Image must be a valid URL" }).nullable(),
    })
    .partial()
    .refine((body) => Object.keys(body).length > 0, {
      message: "Provide at least one field to update: name, phone, address, image",
    }),
});

export const UserValidation = { updateMe };

export type UpdateMeInput = z.infer<typeof updateMe>["body"];
