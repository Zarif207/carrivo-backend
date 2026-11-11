import httpStatus from "http-status";
import { Prisma } from "../../../generated/prisma/client.js";
import { CourierApplicationStatus, Role, UserStatus } from "../../../generated/prisma/enums.js";
import { prisma } from "../../lib/prisma.js";
import type { ErrorDetail } from "../../types/response.types.js";
import { ApiError } from "../../utils/ApiError.js";
import { buildMeta, buildOrderBy, getSkipTake, type Paginated } from "../../utils/pagination.js";
import type { RequestMeta } from "../../utils/requestMeta.js";
import { AdminUserRules } from "../admin/admin.service.js";
import type { CourierProfileInput } from "../admin/admin.validation.js";
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from "../audit/audit.constants.js";
import { AuditService } from "../audit/audit.service.js";
import type { Actor } from "../audit/audit.types.js";
import { NotificationService } from "../notification/notification.service.js";
import { StaffNotify } from "../notification/notification.staff.js";
import type { PendingEmail } from "../notification/notification.types.js";
import type { NotificationContent } from "../notification/notification.utils.js";
import { MY_HISTORY_LIMIT, REAPPLY_COOLDOWN_DAYS } from "./courierApplication.constants.js";
import {
  adminApplicationSelect,
  myApplicationSelect,
  type AdminApplication,
  type MyApplication,
  type MyApplications,
} from "./courierApplication.types.js";
import { applicantDedupeKey, buildApplicantNotification, checkEligibility, reapplyDate, type Refusal } from "./courierApplication.utils.js";
import type { AdminApplicationListQuery, ApplyInput, ApproveInput, RejectInput } from "./courierApplication.validation.js";

type Tx = Prisma.TransactionClient;

/** The Prisma surface this service uses (tests pass an in-memory fake). */
export type CourierApplicationDb = Pick<typeof prisma, "$transaction" | "courierApplication" | "user" | "zone">;

/** Everything the service touches outside its own rows, injectable for DB-free tests. */
export interface CourierApplicationDeps {
  db: CourierApplicationDb;
  now: () => Date;
  /** Staff feed (after commit; never throws). */
  staff: {
    applicationSubmitted: typeof StaffNotify.courierApplicationSubmitted;
    courierAdded: typeof StaffNotify.courierAdded;
  };
  /** Applicant emails, after commit, in the background (never throws). */
  sendEmails: (emails: PendingEmail[]) => Promise<void>;
}

const notFound = (): ApiError => new ApiError(httpStatus.NOT_FOUND, "Courier application not found");
const conflict = (message: string, errors: ErrorDetail[] = []): ApiError => new ApiError(httpStatus.CONFLICT, message, errors);
const refused = (refusal: Refusal, errors: ErrorDetail[] = []): ApiError => new ApiError(refusal.status, refusal.message, errors);

/** 409 for a decision on an application that is no longer PENDING (repeat approve/reject, race). */
const notPending = (status: CourierApplicationStatus, action: string): ApiError =>
  conflict(`Only a pending application can be ${action}. This one is ${status}.`, [{ path: "status", message: status }]);

const isUniqueViolation = (error: unknown): boolean => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

/** Locks the application row (approve/reject/cancel serialize on it) and returns its current status. */
const lockApplication = async (tx: Tx, id: string): Promise<{ id: string; status: CourierApplicationStatus; userId: string }> => {
  const rows = await tx.$queryRaw<{ id: string; status: CourierApplicationStatus; userId: string }[]>`
    SELECT "id", "status", "userId" FROM "courier_applications" WHERE "id" = ${id} FOR UPDATE`;
  const row = rows[0];
  if (!row) throw notFound();
  return row;
};

/**
 * The applicant's notice, written with the decision's transaction client so it commits with it.
 * The dedupe key (application + decision + user) makes a replay insert nothing; the email is
 * only queued for a row that was actually inserted.
 */
const insertApplicantNotice = async (
  tx: Tx,
  recipient: { id: string; name: string; email: string },
  applicationId: string,
  content: NotificationContent,
): Promise<PendingEmail[]> => {
  const dedupeKey = applicantDedupeKey(content.type, applicationId, recipient.id);
  const { count } = await tx.notification.createMany({
    data: [{ userId: recipient.id, type: content.type, title: content.title, message: content.message, link: content.linkPath, dedupeKey }],
    skipDuplicates: true,
  });
  if (count === 0) return [];
  const row = await tx.notification.findUniqueOrThrow({ where: { dedupeKey }, select: { id: true } });
  return [{ notificationId: row.id, to: recipient.email, recipientName: recipient.name, content }];
};

export const createCourierApplicationService = (deps: CourierApplicationDeps) => {
  const { db } = deps;

  /** The caller's PENDING application and latest rejection: what eligibility depends on. */
  const eligibilityFor = async (userId: string, role: Role) => {
    const [pending, lastRejected] = await Promise.all([
      db.courierApplication.findFirst({ where: { userId, status: CourierApplicationStatus.PENDING }, select: { createdAt: true } }),
      db.courierApplication.findFirst({
        where: { userId, status: CourierApplicationStatus.REJECTED },
        orderBy: [{ reviewedAt: "desc" }, { id: "desc" }],
        select: { reviewedAt: true, createdAt: true },
      }),
    ]);
    return checkEligibility({
      role,
      pending,
      lastRejectedAt: lastRejected ? (lastRejected.reviewedAt ?? lastRejected.createdAt) : null,
      now: deps.now(),
    });
  };

  const loadApplicant = async (userId: string) => {
    const user = await db.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true, name: true, email: true, role: true, status: true },
    });
    if (!user || user.status !== UserStatus.ACTIVE) throw new ApiError(httpStatus.UNAUTHORIZED, "Account is deactivated");
    return user;
  };

  /** CUSTOMER only; one PENDING at a time (DB-enforced too); 7-day wait after a rejection. */
  const apply = async (actor: Actor, input: ApplyInput, meta: RequestMeta): Promise<MyApplication> => {
    const user = await loadApplicant(actor.id);
    const eligibility = await eligibilityFor(user.id, user.role);
    if (eligibility.refusal) {
      throw refused(
        eligibility.refusal,
        eligibility.canReapplyAt ? [{ path: "canReapplyAt", message: eligibility.canReapplyAt.toISOString() }] : [],
      );
    }

    let zoneName: string | null = null;
    if (input.preferredZoneId) {
      const zone = await db.zone.findFirst({ where: { id: input.preferredZoneId, deletedAt: null, isActive: true }, select: { name: true } });
      if (!zone) {
        throw new ApiError(httpStatus.BAD_REQUEST, "Zone not found or inactive", [{ path: "body.preferredZoneId", message: "Zone not found or inactive" }]);
      }
      zoneName = zone.name;
    }

    let created: MyApplication;
    try {
      created = await db.$transaction(async (tx) => {
        const row = await tx.courierApplication.create({
          data: {
            userId: user.id,
            phone: input.phone,
            preferredZoneId: input.preferredZoneId ?? null,
            vehicleType: input.vehicleType,
            vehiclePlate: input.vehiclePlate ?? null,
            availability: input.availability,
            experience: input.experience ?? null,
            about: input.about ?? null,
          },
          select: myApplicationSelect,
        });
        await AuditService.log(tx, {
          actor,
          action: AUDIT_ACTIONS.COURIER_APPLICATION_SUBMITTED,
          entityType: AUDIT_ENTITIES.COURIER_APPLICATION,
          entityId: row.id,
          after: { status: row.status, vehicleType: row.vehicleType, preferredZoneId: input.preferredZoneId ?? null, availability: row.availability },
          meta,
        });
        return row;
      });
    } catch (error) {
      // Two submits at once: the partial unique index (one PENDING per user) let only one in.
      if (isUniqueViolation(error)) throw conflict("You already have a pending application. Cancel it before applying again.");
      throw error;
    }

    await deps.staff.applicationSubmitted({ id: created.id, vehicleType: created.vehicleType, zoneName }, { name: user.name, email: user.email });
    return created;
  };

  /** The caller's latest application, full history, and whether/when they may apply again. */
  const getMine = async (actor: Actor): Promise<MyApplications> => {
    const user = await loadApplicant(actor.id);
    const [history, eligibility] = await Promise.all([
      db.courierApplication.findMany({
        where: { userId: user.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: MY_HISTORY_LIMIT,
        select: myApplicationSelect,
      }),
      eligibilityFor(user.id, user.role),
    ]);
    return {
      latest: history[0] ?? null,
      history,
      canApply: eligibility.canApply,
      canReapplyAt: eligibility.canReapplyAt,
      blockedReason: eligibility.refusal?.message ?? null,
      cooldownDays: REAPPLY_COOLDOWN_DAYS,
    };
  };

  /** Owner only (another user's id → 404), and only while PENDING (else 409). */
  const cancelMine = async (actor: Actor, id: string, meta: RequestMeta): Promise<MyApplication> =>
    db.$transaction(async (tx) => {
      const row = await lockApplication(tx, id);
      if (row.userId !== actor.id) throw notFound();
      if (row.status !== CourierApplicationStatus.PENDING) throw notPending(row.status, "cancelled");
      const updated = await tx.courierApplication.update({
        where: { id },
        data: { status: CourierApplicationStatus.CANCELLED },
        select: myApplicationSelect,
      });
      await AuditService.log(tx, {
        actor,
        action: AUDIT_ACTIONS.COURIER_APPLICATION_CANCELLED,
        entityType: AUDIT_ENTITIES.COURIER_APPLICATION,
        entityId: id,
        before: { status: row.status },
        after: { status: updated.status },
        meta,
      });
      return updated;
    });

  // ───────── Staff ─────────

  const adminList = async (query: AdminApplicationListQuery): Promise<Paginated<AdminApplication>> => {
    const term = query.searchTerm;
    const where: Prisma.CourierApplicationWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.zoneId ? { preferredZoneId: query.zoneId } : {}),
      ...(query.vehicleType ? { vehicleType: query.vehicleType } : {}),
      ...(term
        ? {
            OR: [
              { user: { name: { contains: term, mode: "insensitive" } } },
              { user: { email: { contains: term, mode: "insensitive" } } },
              { phone: { contains: term, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      db.courierApplication.findMany({
        where,
        select: adminApplicationSelect,
        orderBy: buildOrderBy(query.sortBy, query.sortOrder),
        ...getSkipTake(query),
      }),
      db.courierApplication.count({ where }),
    ]);
    return { data: rows, meta: buildMeta(query, total) };
  };

  const adminGet = async (id: string): Promise<AdminApplication> => {
    const row = await db.courierApplication.findUnique({ where: { id }, select: adminApplicationSelect });
    if (!row) throw notFound();
    return row;
  };

  /**
   * One transaction, same steps as PATCH /admin/users/:id/role → COURIER: lock the active admins
   * and the applicant (beginUserChange), lock the application and require PENDING (a repeat
   * approve gets 409 with the current status, so nothing runs twice), refuse anyone who is not a
   * CUSTOMER, refuse orphaned active shipments, create/restore the courier profile (zone from the
   * application unless overridden), set role COURIER, and revoke every session so the next sign-in
   * carries the new role. Audit rows and the applicant's notice commit with it.
   */
  const approve = async (actor: Actor, id: string, input: ApproveInput, meta: RequestMeta): Promise<AdminApplication> => {
    const decided = await db.$transaction(async (tx) => {
      const target = await tx.courierApplication.findUnique({ where: { id }, select: { userId: true } });
      if (!target) throw notFound();
      const { user } = await AdminUserRules.beginUserChange(tx, actor, target.userId);
      const locked = await lockApplication(tx, id);
      if (locked.status !== CourierApplicationStatus.PENDING) throw notPending(locked.status, "approved");
      if (user.role !== Role.CUSTOMER) {
        throw conflict(`The applicant is already ${user.role}; only a customer can be made a courier. Reject the application instead.`, [
          { path: "user.role", message: user.role },
        ]);
      }
      if (user.status !== UserStatus.ACTIVE) throw conflict("The applicant's account is deactivated. Reactivate it or reject the application.");
      await AdminUserRules.assertNoActiveWork(tx, user, "approve this application");

      const app = await tx.courierApplication.findUniqueOrThrow({
        where: { id },
        select: { phone: true, preferredZoneId: true, vehicleType: true, vehiclePlate: true },
      });
      const zoneId = input.zoneId ?? app.preferredZoneId;
      if (!zoneId) {
        throw new ApiError(httpStatus.BAD_REQUEST, "Choose a zone: the applicant did not pick one", [
          { path: "body.zoneId", message: "Required when the application has no preferred zone" },
        ]);
      }
      // No licenceNumber: applications never collect government IDs.
      const profile: CourierProfileInput = { zoneId, hubId: input.hubId ?? null, vehicleType: app.vehicleType, vehicleNumber: app.vehiclePlate };
      await AdminUserRules.upsertCourierProfile(tx, user.id, profile);

      const contact = await tx.user.findUniqueOrThrow({ where: { id: user.id }, select: { name: true, email: true, phone: true } });
      // Customers can't edit their role; the applicant's phone fills an empty account phone.
      await tx.user.update({ where: { id: user.id }, data: { role: Role.COURIER, ...(contact.phone ? {} : { phone: app.phone }) } });
      await tx.courierApplication.update({
        where: { id },
        data: { status: CourierApplicationStatus.APPROVED, reviewedById: actor.id, reviewedAt: deps.now() },
      });
      // Sessions are rows in "sessions" (Better Auth, no cookie cache): deleting them signs the
      // user out everywhere at once, and the next sign-in issues a session for a COURIER.
      const { count: sessionsRevoked } = await tx.session.deleteMany({ where: { userId: user.id } });

      const auditBase = { actor, meta };
      await AuditService.log(tx, {
        ...auditBase,
        action: AUDIT_ACTIONS.COURIER_APPLICATION_APPROVED,
        entityType: AUDIT_ENTITIES.COURIER_APPLICATION,
        entityId: id,
        before: { status: locked.status },
        after: { status: CourierApplicationStatus.APPROVED, userId: user.id, courierProfile: AdminUserRules.profileData(profile) },
      });
      await AuditService.log(tx, {
        ...auditBase,
        action: AUDIT_ACTIONS.USER_ROLE_CHANGED,
        entityType: AUDIT_ENTITIES.USER,
        entityId: user.id,
        before: { role: user.role },
        after: { role: Role.COURIER, sessionsRevoked, via: "courier_application", applicationId: id },
      });

      const zone = await tx.zone.findUniqueOrThrow({ where: { id: zoneId }, select: { name: true } });
      const emails = await insertApplicantNotice(
        tx,
        { id: user.id, name: contact.name, email: contact.email },
        id,
        buildApplicantNotification({ kind: "APPROVED", applicationId: id, zoneName: zone.name, vehicleType: app.vehicleType }),
      );
      return { emails, courier: { id: user.id, name: contact.name, email: contact.email, zoneName: zone.name } };
    });

    void deps.sendEmails(decided.emails);
    await deps.staff.courierAdded(decided.courier, "application", actor, id);
    return adminGet(id);
  };

  /** PENDING → REJECTED with the admin's note (shown to the applicant); the role never changes. */
  const reject = async (actor: Actor, id: string, input: RejectInput, meta: RequestMeta): Promise<AdminApplication> => {
    const emails = await db.$transaction(async (tx) => {
      const target = await tx.courierApplication.findUnique({ where: { id }, select: { userId: true } });
      if (!target) throw notFound();
      await AdminUserRules.beginUserChange(tx, actor, target.userId); // re-checks the acting admin, same lock order as approve
      const locked = await lockApplication(tx, id);
      if (locked.status !== CourierApplicationStatus.PENDING) throw notPending(locked.status, "rejected");

      const reviewedAt = deps.now();
      await tx.courierApplication.update({
        where: { id },
        data: { status: CourierApplicationStatus.REJECTED, reviewedById: actor.id, reviewedAt, reviewNote: input.note },
      });
      await AuditService.log(tx, {
        actor,
        action: AUDIT_ACTIONS.COURIER_APPLICATION_REJECTED,
        entityType: AUDIT_ENTITIES.COURIER_APPLICATION,
        entityId: id,
        before: { status: locked.status },
        after: { status: CourierApplicationStatus.REJECTED, note: input.note },
        meta,
      });
      const contact = await tx.user.findUniqueOrThrow({ where: { id: locked.userId }, select: { id: true, name: true, email: true } });
      return insertApplicantNotice(
        tx,
        contact,
        id,
        buildApplicantNotification({ kind: "REJECTED", applicationId: id, note: input.note, reapplyAt: reapplyDate(reviewedAt) }),
      );
    });
    void deps.sendEmails(emails);
    return adminGet(id);
  };

  return { apply, getMine, cancelMine, adminList, adminGet, approve, reject };
};

export const CourierApplicationService = createCourierApplicationService({
  db: prisma,
  now: () => new Date(),
  staff: { applicationSubmitted: StaffNotify.courierApplicationSubmitted, courierAdded: StaffNotify.courierAdded },
  sendEmails: NotificationService.sendAfterCommit,
});
