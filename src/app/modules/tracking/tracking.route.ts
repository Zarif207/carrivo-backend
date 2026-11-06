import { Router } from "express";
import { validateRequest } from "../../middlewares/validateRequest.js";
import { TrackingController } from "./tracking.controller.js";
import { TrackingValidation } from "./tracking.validation.js";

const router = Router();

// Public: anyone with the tracking id can follow the parcel. No private fields are returned.
router.get("/:trackingId", validateRequest(TrackingValidation.byTrackingId), TrackingController.track);

export const TrackingRoutes = router;
