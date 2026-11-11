import { CourierApplicationStatus, Role } from "../../../generated/prisma/enums.js";
import { FRONTEND_PATHS } from "../../config/frontendRoutes.js";
import { formatBusinessDate } from "../../utils/timezone.js";
import type { NotificationContent } from "../notification/notification.utils.js";
import { DAY_MS, REAPPLY_COOLDOWN_DAYS } from "./courierApplication.constants.js";

/*
 * Pure courier-application rules: no env, no database, so they are unit-tested directly.
 * The service feeds them what it read; route guards and the service share the same answers.
 */

/** HTTP status + message for a refusal (the service turns it into an ApiError). */
export interface Refusal {
  status: 403 | 409;
  message: string;
}

/** Only customers apply. Staff get 403 (wrong kind of account); couriers 409 (already done). */
export const roleRefusal = (role: Role): Refusal | null => {
  switch (role) {
    case Role.CUSTOMER:
      return null;
    case Role.COURIER:
      return { status: 409, message: "You are already a courier" };
    default:
      return { status: 403, message: "Staff accounts can't apply to become couriers. Only customer accounts can apply." };
  }
};

/** When a rejected applicant may apply again. */
export const reapplyDate = (rejectedAt: Date): Date => new Date(rejectedAt.getTime() + REAPPLY_COOLDOWN_DAYS * DAY_MS);

export interface EligibilityInput {
  role: Role;
  /** The caller's PENDING application, if any. */
  pending: { createdAt: Date } | null;
  /** reviewedAt of the caller's most recent REJECTED application, if any. */
  lastRejectedAt: Date | null;
  now: Date;
}

export interface Eligibility {
  canApply: boolean;
  /** Set while a rejection cooldown runs. */
  canReapplyAt: Date | null;
  refusal: Refusal | null;
}

/** May this caller submit a new application now? One answer for POST and for GET /my. */
export const checkEligibility = ({ role, pending, lastRejectedAt, now }: EligibilityInput): Eligibility => {
  const byRole = roleRefusal(role);
  if (byRole) return { canApply: false, canReapplyAt: null, refusal: byRole };
  if (pending) {
    return {
      canApply: false,
      canReapplyAt: null,
      refusal: {
        status: 409,
        message: `You already have a pending application from ${formatBusinessDate(pending.createdAt)}. Cancel it before applying again.`,
      },
    };
  }
  if (lastRejectedAt) {
    const at = reapplyDate(lastRejectedAt);
    if (now.getTime() < at.getTime()) {
      return {
        canApply: false,
        canReapplyAt: at,
        refusal: { status: 409, message: `Your last application was not approved. You can apply again on ${formatBusinessDate(at)}.` },
      };
    }
  }
  return { canApply: true, canReapplyAt: null, refusal: null };
};

/** Statuses that are final: nothing changes them again. */
export const isDecided = (status: CourierApplicationStatus): boolean => status !== CourierApplicationStatus.PENDING;

const label = (value: string): string => value.replace(/_/g, " ").toLowerCase();

/** Ends free text with a full stop unless it already ends a sentence. */
const sentence = (text: string): string => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

export type ApplicantEvent =
  | { kind: "APPROVED"; applicationId: string; zoneName: string; vehicleType: string }
  | { kind: "REJECTED"; applicationId: string; note: string; reapplyAt: Date };

/** The applicant's in-app notice (and email) for a decision. */
export const buildApplicantNotification = (event: ApplicantEvent): NotificationContent => {
  if (event.kind === "APPROVED") {
    return {
      type: "COURIER_APPLICATION_APPROVED",
      title: "You are now a Carrivo courier",
      message: `Your courier application was approved for ${event.zoneName}. You are now a courier: please sign in again to open your courier dashboard.`,
      details: [`Zone: ${event.zoneName}`, `Vehicle: ${label(event.vehicleType)}`],
      linkPath: FRONTEND_PATHS.dashboard,
      ctaLabel: "Sign in as a courier",
    };
  }
  const date = formatBusinessDate(event.reapplyAt);
  return {
    type: "COURIER_APPLICATION_REJECTED",
    title: "Your courier application was not approved",
    message: `Your courier application was not approved. Reason: ${sentence(event.note)} You can apply again on ${date}.`,
    details: [`Reason: ${event.note}`, `You can apply again on: ${date}`],
    linkPath: FRONTEND_PATHS.courierApplication,
    ctaLabel: "View your application",
  };
};

/** Per-recipient dedupe key: one notice per application and decision. */
export const applicantDedupeKey = (type: NotificationContent["type"], applicationId: string, userId: string): string =>
  `${type}:application:${applicationId}:${userId}`;
