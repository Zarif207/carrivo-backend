import httpStatus from "http-status";
import { Prisma } from "../../../generated/prisma/client.js";
import { PaymentStatus, Role, ShipmentStatus, UserStatus } from "../../../generated/prisma/enums.js";
import { PLATFORM_CURRENCY } from "../../config/currency.js";
import { auth } from "../../lib/auth.js";
import { CACHE_KEYS, CACHE_TTL, cache } from "../../lib/cache.js";
import { prisma } from "../../lib/prisma.js";
import type { ErrorDetail } from "../../types/response.types.js";
import { ApiError } from "../../utils/ApiError.js";
import { formatMoney } from "../../utils/money.js";
import { buildMeta, buildOrderBy, getSkipTake, type Paginated } from "../../utils/pagination.js";
import type { RequestMeta } from "../../utils/requestMeta.js";
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from "../audit/audit.constants.js";
import { AuditService } from "../audit/audit.service.js";
import type { Actor } from "../audit/audit.types.js";
import { StaffNotify } from "../notification/notification.staff.js";
import { BUSINESS_TIMEZONE, TERMINAL_STATUSES } from "../shipment/shipment.constants.js";
import { adminUserSelect, type AdminUser, type AdminUserRow, type DashboardStats } from "./admin.types.js";
import type {
  AdminUserListQuery,
  ChangeRoleInput,
  ChangeStatusInput,
  CourierProfileInput,
  CreateUserInput,
} from "./admin.validation.js";

type Db = Prisma.TransactionClient;

const notFound = (): ApiError => new ApiError(httpStatus.NOT_FOUND, "User not found");
const forbidden = (message: string): ApiError => new ApiError(httpStatus.FORBIDDEN, message);
const conflict = (message: string, errors: ErrorDetail[] = []): ApiError =>
  new ApiError(httpStatus.CONFLICT, message, errors);

/** Hides soft-deleted courier profiles and the profile's deletedAt column. */
const toAdminUser = ({ courierProfile, ...user }: AdminUserRow): AdminUser => {
  if (!courierProfile || courierProfile.deletedAt) return { ...user, courierProfile: null };
  const { deletedAt: _deletedAt, ...profile } = courierProfile;
  return { ...user, courierProfile: profile };
};

const courierSummary = (user: AdminUser) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  zoneName: user.courierProfile?.zone.name ?? null,
});

const getUser = async (id: string): Promise<AdminUser> => {
  const row = await prisma.user.findFirst({ where: { id, deletedAt: null }, select: adminUserSelect });
  if (!row) throw notFound();
  return toAdminUser(row);
};

const listUsers = async (query: AdminUserListQuery): Promise<Paginated<AdminUser>> => {
  const where: Prisma.UserWhereInput = {
    deletedAt: null,
    ...(query.role ? { role: query.role } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.searchTerm
      ? {
          OR: [
            { name: { contains: query.searchTerm, mode: "insensitive" } },
            { email: { contains: query.searchTerm, mode: "insensitive" } },
            { phone: { contains: query.searchTerm, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: adminUserSelect,
      orderBy: buildOrderBy(query.sortBy, query.sortOrder),
      ...getSkipTake(query),
    }),
    prisma.user.count({ where }),
  ]);
  return { data: rows.map(toAdminUser), meta: buildMeta(query, total) };
};

/** Zone must be active; the hub (optional) must be active and inside that zone. */
const assertCourierProfileTargets = async (db: Db, profile: CourierProfileInput): Promise<void> => {
  const zone = await db.zone.findFirst({
    where: { id: profile.zoneId, deletedAt: null, isActive: true },
    select: { id: true },
  });
  if (!zone) {
    throw new ApiError(httpStatus.BAD_REQUEST, "Zone not found or inactive", [
      { path: "body.courierProfile.zoneId", message: "Zone not found or inactive" },
    ]);
  }
  if (profile.hubId) {
    const hub = await db.hub.findFirst({
      where: { id: profile.hubId, deletedAt: null, isActive: true },
      select: { zoneId: true },
    });
    if (!hub || hub.zoneId !== profile.zoneId) {
      throw new ApiError(httpStatus.BAD_REQUEST, "Hub not found, inactive or not in the zone", [
        { path: "body.courierProfile.hubId", message: "Hub must be active and inside zoneId" },
      ]);
    }
  }
};

const profileData = (profile: CourierProfileInput) => ({
  zoneId: profile.zoneId,
  hubId: profile.hubId ?? null,
  vehicleType: profile.vehicleType,
  vehicleNumber: profile.vehicleNumber ?? null,
  licenseNumber: profile.licenseNumber ?? null,
});

/**
 * Gives the user an active, available courier profile: created, or replaced and restored if one
 * exists (soft-deleted after an earlier role change). Targets are validated first.
 */
const upsertCourierProfile = async (db: Db, userId: string, profile: CourierProfileInput): Promise<void> => {
  await assertCourierProfileTargets(db, profile);
  const data = { ...profileData(profile), deletedAt: null, isAvailable: true };
  await db.courierProfile.upsert({ where: { userId }, create: { userId, ...data }, update: data });
};

/**
 * Admin creates a COURIER or ADMIN through Better Auth (so the password is hashed
 * by Better Auth), then sets the role/profile in our own transaction. Better
 * Auth's sign-up is not part of that transaction, so if the second step fails the
 * just-created user is deleted again: no half-created CUSTOMER is left behind.
 */
const createUser = async (actor: Actor, payload: CreateUserInput, meta: RequestMeta): Promise<AdminUser> => {
  if (payload.courierProfile) await assertCourierProfileTargets(prisma, payload.courierProfile);

  // Server-side call: the HTTP route is disabled, and `role` can't be passed in (input: false).
  const result = await auth.api.signUpEmail({
    body: {
      name: payload.name,
      email: payload.email,
      password: payload.password,
      ...(payload.phone ? { phone: payload.phone } : {}),
    },
  });
  const userId = result.user.id;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { role: payload.role, emailVerified: true } });
      if (payload.courierProfile) {
        await tx.courierProfile.create({
          data: { userId, ...profileData(payload.courierProfile), isAvailable: true },
          select: { id: true },
        });
      }
      // Sign-up signs the new user in; the admin doesn't need that session.
      await tx.session.deleteMany({ where: { userId } });
      await AuditService.log(tx, {
        actor,
        action: AUDIT_ACTIONS.USER_CREATED,
        entityType: AUDIT_ENTITIES.USER,
        entityId: userId,
        // The password is never part of the snapshot (and would be redacted anyway).
        after: {
          email: payload.email,
          name: payload.name,
          role: payload.role,
          ...(payload.courierProfile ? { courierProfile: profileData(payload.courierProfile) } : {}),
        },
        meta,
      });
    });
  } catch (error) {
    // Compensate: remove the user Better Auth created (sessions/accounts cascade).
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    throw error;
  }
  const created = await getUser(userId);
  if (created.role === Role.COURIER) await StaffNotify.courierAdded(courierSummary(created), "created", actor);
  return created;
};

/**
 * Row-locks every ACTIVE admin (ordered by id, so concurrent callers lock in the
 * same order) for the rest of the transaction. Two admins demoting each other at
 * the same time are serialized: the second one waits, then sees the first one's
 * result instead of both passing a stale "another admin exists" check.
 */
const lockActiveAdmins = async (db: Db): Promise<string[]> => {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "users"
    WHERE "role" = 'ADMIN' AND "status" = 'ACTIVE' AND "deletedAt" IS NULL
    ORDER BY "id"
    FOR UPDATE`;
  return rows.map((row) => row.id);
};

/** Serializes with courier assignment, which locks the same user row. */
const lockUser = async (db: Db, id: string): Promise<void> => {
  await db.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${id} FOR UPDATE`;
};

interface TargetUser {
  id: string;
  role: Role;
  status: UserStatus;
  courierProfile: { id: string; deletedAt: Date | null } | null;
}

/** Locks, re-checks the acting admin, and loads the target. */
const beginUserChange = async (db: Db, actor: Actor, id: string): Promise<{ admins: string[]; user: TargetUser }> => {
  const admins = await lockActiveAdmins(db);
  if (!admins.includes(actor.id)) throw forbidden("Your admin access has changed; please sign in again");
  await lockUser(db, id);
  const user = await db.user.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, role: true, status: true, courierProfile: { select: { id: true, deletedAt: true } } },
  });
  if (!user) throw notFound();
  return { admins, user };
};

const assertNotLastAdmin = (admins: string[], user: TargetUser): void => {
  if (user.role === Role.ADMIN && user.status === UserStatus.ACTIVE && admins.filter((a) => a !== user.id).length === 0) {
    throw conflict("This is the last active admin and cannot be removed");
  }
};

/** 409 if the change would orphan unfinished shipments (courier: assigned; customer: owned). */
const assertNoActiveWork = async (db: Db, user: TargetUser, action: string): Promise<void> => {
  const scope: Prisma.ShipmentWhereInput | null =
    user.role === Role.COURIER ? { courierId: user.id } : user.role === Role.CUSTOMER ? { customerId: user.id } : null;
  if (!scope) return;
  const where: Prisma.ShipmentWhereInput = { ...scope, deletedAt: null, status: { notIn: [...TERMINAL_STATUSES] } };
  const count = await db.shipment.count({ where });
  if (count === 0) return;
  const sample = await db.shipment.findMany({ where, select: { trackingId: true }, orderBy: { createdAt: "asc" }, take: 5 });
  const who = user.role === Role.COURIER ? "assigned to this courier" : "owned by this customer";
  throw conflict(`Cannot ${action}: ${count} active shipment(s) are ${who}`, [
    {
      path: "shipments",
      message: `Finish, unassign or cancel these first: ${sample.map((s) => s.trackingId).join(", ")}${count > 5 ? ", ..." : ""}`,
    },
  ]);
};

/** Role change. Rules: not yourself, not the last active admin, no orphaned active work. Logs the user out. */
const changeRole = async (actor: Actor, id: string, payload: ChangeRoleInput, meta: RequestMeta): Promise<AdminUser> => {
  if (id === actor.id) throw forbidden("You cannot change your own role");
  await prisma.$transaction(async (tx) => {
    const { admins, user } = await beginUserChange(tx, actor, id);
    // Read-only viewer accounts are managed by the seed only, never through the API.
    if (user.role === Role.ADMIN_VIEWER) throw forbidden("Viewer accounts are managed by the seed and can't change role");
    if (user.role === payload.role) {
      throw new ApiError(httpStatus.BAD_REQUEST, `User is already ${payload.role}`);
    }
    assertNotLastAdmin(admins, user);
    await assertNoActiveWork(tx, user, "change this user's role");

    const profile = user.courierProfile;
    if (payload.role === Role.COURIER) {
      if (payload.courierProfile) {
        await upsertCourierProfile(tx, id, payload.courierProfile);
      } else if (profile) {
        await tx.courierProfile.update({ where: { id: profile.id }, data: { deletedAt: null, isAvailable: true } });
      } else {
        throw new ApiError(httpStatus.BAD_REQUEST, "courierProfile is required to make this user a COURIER", [
          { path: "body.courierProfile", message: "Required" },
        ]);
      }
    } else if (user.role === Role.COURIER && profile && !profile.deletedAt) {
      // Earnings and history stay; the profile is retired.
      await tx.courierProfile.update({ where: { id: profile.id }, data: { deletedAt: new Date(), isAvailable: false } });
    }

    await tx.user.update({ where: { id }, data: { role: payload.role } });
    const { count: sessionsRevoked } = await tx.session.deleteMany({ where: { userId: id } });
    await AuditService.log(tx, {
      actor,
      action: AUDIT_ACTIONS.USER_ROLE_CHANGED,
      entityType: AUDIT_ENTITIES.USER,
      entityId: id,
      before: { role: user.role },
      after: {
        role: payload.role,
        sessionsRevoked,
        ...(payload.courierProfile ? { courierProfile: profileData(payload.courierProfile) } : {}),
      },
      meta,
    });
  });
  const updated = await getUser(id);
  if (payload.role === Role.COURIER) await StaffNotify.courierAdded(courierSummary(updated), "role_changed", actor);
  return updated;
};

/** Activate / deactivate. Deactivation revokes every session immediately. */
const changeStatus = async (actor: Actor, id: string, payload: ChangeStatusInput, meta: RequestMeta): Promise<AdminUser> => {
  if (id === actor.id) throw forbidden("You cannot change your own status");
  await prisma.$transaction(async (tx) => {
    const { admins, user } = await beginUserChange(tx, actor, id);
    if (user.status === payload.status) {
      throw new ApiError(httpStatus.BAD_REQUEST, `User is already ${payload.status}`);
    }
    let sessionsRevoked = 0;
    if (payload.status === UserStatus.INACTIVE) {
      assertNotLastAdmin(admins, user);
      // Couriers only: their assigned shipments would be stuck. Customers' shipments carry on.
      if (user.role === Role.COURIER) await assertNoActiveWork(tx, user, "deactivate this courier");
      if (user.courierProfile && !user.courierProfile.deletedAt) {
        await tx.courierProfile.update({ where: { id: user.courierProfile.id }, data: { isAvailable: false } });
      }
      await tx.user.update({ where: { id }, data: { status: UserStatus.INACTIVE } });
      sessionsRevoked = (await tx.session.deleteMany({ where: { userId: id } })).count;
    } else {
      // Reactivated couriers stay unavailable until they switch availability on.
      await tx.user.update({ where: { id }, data: { status: UserStatus.ACTIVE } });
    }
    await AuditService.log(tx, {
      actor,
      action: AUDIT_ACTIONS.USER_STATUS_CHANGED,
      entityType: AUDIT_ENTITIES.USER,
      entityId: id,
      before: { status: user.status },
      after: { status: payload.status, reason: payload.reason ?? null, sessionsRevoked },
      meta,
    });
  });
  return getUser(id);
};

// ───────── Dashboard ─────────

/** 30 US Eastern calendar days (today included), zero-filled, computed in SQL (DST-aware). */
const shipmentsPerDay = () =>
  prisma.$queryRaw<{ date: string; count: number }[]>`
    WITH days AS (
      SELECT generate_series(
        (now() AT TIME ZONE ${BUSINESS_TIMEZONE})::date - 29,
        (now() AT TIME ZONE ${BUSINESS_TIMEZONE})::date,
        interval '1 day'
      )::date AS day
    ), counts AS (
      SELECT (("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${BUSINESS_TIMEZONE})::date AS day, count(*)::int AS count
      FROM "shipments"
      WHERE "deletedAt" IS NULL AND "createdAt" >= (now() AT TIME ZONE 'UTC') - interval '31 days'
      GROUP BY 1
    )
    SELECT to_char(d.day, 'YYYY-MM-DD') AS "date", COALESCE(c.count, 0)::int AS "count"
    FROM days d LEFT JOIN counts c ON c.day = d.day
    ORDER BY d.day`;

const computeDashboardStats = async (): Promise<DashboardStats> => {
  const live: Prisma.ShipmentWhereInput = { deletedAt: null };
  const [byStatusRows, paymentGroups, perDay, top, failed, activeCouriers, activeCustomers, activeHubs] = await Promise.all([
    prisma.shipment.groupBy({ by: ["status"], where: live, _count: { _all: true } }),
    // One grouped aggregate gives both the counts and the money per payment status.
    prisma.payment.groupBy({ by: ["status"], where: { currency: PLATFORM_CURRENCY }, _count: { _all: true }, _sum: { amount: true } }),
    shipmentsPerDay(),
    prisma.shipment.groupBy({
      by: ["courierId"],
      where: { ...live, status: ShipmentStatus.DELIVERED, courierId: { not: null } },
      _count: { courierId: true },
      orderBy: { _count: { courierId: "desc" } },
      take: 5,
    }),
    prisma.shipment.aggregate({ where: live, _sum: { failedAttempts: true } }),
    prisma.user.count({ where: { role: Role.COURIER, status: UserStatus.ACTIVE, deletedAt: null } }),
    prisma.user.count({ where: { role: Role.CUSTOMER, status: UserStatus.ACTIVE, deletedAt: null } }),
    prisma.hub.count({ where: { isActive: true, deletedAt: null } }),
  ]);

  const byStatus = Object.fromEntries(Object.values(ShipmentStatus).map((s) => [s, 0])) as Record<ShipmentStatus, number>;
  for (const row of byStatusRows) byStatus[row.status] = row._count._all;
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);

  const courierIds = top.map((t) => t.courierId).filter((id): id is string => id !== null);
  const names = new Map(
    (await prisma.user.findMany({ where: { id: { in: courierIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]),
  );

  const paymentsByStatus = Object.fromEntries(Object.values(PaymentStatus).map((s) => [s, 0])) as Record<PaymentStatus, number>;
  const sumBy = (statuses: PaymentStatus[]): Prisma.Decimal =>
    paymentGroups
      .filter((g) => statuses.includes(g.status))
      .reduce((acc, g) => acc.plus(g._sum.amount ?? 0), new Prisma.Decimal(0));
  for (const g of paymentGroups) paymentsByStatus[g.status] = g._count._all;
  const grossCollected = sumBy([PaymentStatus.PAID, PaymentStatus.REFUND_PENDING, PaymentStatus.REFUNDED]);
  const refunded = sumBy([PaymentStatus.REFUNDED]);

  const failedAttempts = failed._sum.failedAttempts ?? 0;
  const delivered = byStatus.DELIVERED;
  const attempts = failedAttempts + delivered;

  return {
    shipments: { total, byStatus },
    revenue: {
      currency: PLATFORM_CURRENCY,
      grossCollected: formatMoney(grossCollected),
      refunded: formatMoney(refunded),
      net: formatMoney(grossCollected.minus(refunded)),
    },
    paymentsByStatus,
    shipmentsPerDay: perDay,
    topCouriers: top
      .filter((t) => t.courierId !== null)
      .map((t) => ({ id: t.courierId ?? "", name: names.get(t.courierId ?? "") ?? "Unknown", deliveries: t._count.courierId })),
    failedDeliveryRate: {
      rate: attempts === 0 ? 0 : Math.round((failedAttempts / attempts) * 10_000) / 10_000,
      failedAttempts,
      deliveredShipments: delivered,
    },
    counts: { activeCouriers, activeCustomers, activeHubs },
    generatedAt: new Date().toISOString(),
  };
};

/** Cached 60 s for all admins (identical for every admin; never role-scoped). */
const dashboardStats = (): Promise<DashboardStats> =>
  cache.getOrLoad(CACHE_KEYS.dashboardStats, CACHE_TTL.dashboardStats, computeDashboardStats);

export const AdminService = { listUsers, getUser, createUser, changeRole, changeStatus, dashboardStats };

/**
 * The role-change building blocks, shared with courier-application approval so a courier made
 * from an application is set up exactly like one made by PATCH /admin/users/:id/role.
 */
export const AdminUserRules = { beginUserChange, assertNoActiveWork, upsertCourierProfile, profileData, getUser, courierSummary };
