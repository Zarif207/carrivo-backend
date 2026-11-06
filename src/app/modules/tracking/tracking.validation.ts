import { z } from "zod";
import { TRACKING_ID_PATTERN } from "../shipment/shipment.constants.js";

const byTrackingId = z.object({
  params: z.strictObject({
    trackingId: z
      .string()
      .trim()
      .toUpperCase()
      .regex(TRACKING_ID_PATTERN, { message: "Tracking ID must look like CRV-YYMMDD-XXXXXX" }),
  }),
});

export const TrackingValidation = { byTrackingId };

export type TrackingParams = z.infer<typeof byTrackingId>["params"];
