import { z } from "zod";
import { phoneSchema, usAddressSchema } from "../../utils/commonValidation.js";

const updateMe = z.object({
  body: z
    .strictObject({
      name: z.string().trim().min(2, { message: "Name must be at least 2 characters" }).max(100),
      phone: phoneSchema.nullable(),
      address: usAddressSchema.nullable(),
      image: z.url({ message: "Image must be a valid URL" }).nullable(),
    })
    .partial()
    .refine((body) => Object.keys(body).length > 0, {
      message: "Provide at least one field to update: name, phone, address, image",
    }),
});

export const UserValidation = { updateMe };

export type UpdateMeInput = z.infer<typeof updateMe>["body"];
