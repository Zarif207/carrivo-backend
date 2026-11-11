import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, describe, it, mock } from "node:test";
import { CourierApplicationStatus, Role, UserStatus, VehicleType, WorkAvailability } from "../../../generated/prisma/enums.js";

// No database in unit tests: the service runs on the in-memory fake below. Point the real client at
// a closed local port anyway, so an accidental real query can never reach a shared database.
process.env["DATABASE_URL"] = "postgresql://test@127.0.0.1:1/none";
process.env["DIRECT_URL"] = "postgresql://test@127.0.0.1:1/none";
process.env["UPSTASH_REDIS_REST_URL"] = "";
process.env["UPSTASH_REDIS_REST_TOKEN"] = "";

const { Prisma } = await import("../../../generated/prisma/client.js");
const { default: app } = await import("../../../app.js");
const { auth } = await import("../../lib/auth.js");
const { READ_ONLY_MESSAGE } = await import("../../middlewares/readOnly.js");
const { notifyStaff } = await import("../notification/notification.staff.js");
const { buildStaffNotification } = await import("../notification/notification.staff.utils.js");
const { renderEmail } = await import("../notification/notification.utils.js");
const { createCourierApplicationService, CourierApplicationService } = await import("./courierApplication.service.js");
const { REAPPLY_COOLDOWN_DAYS, DAY_MS } = await import("./courierApplication.constants.js");
const { checkEligibility, roleRefusal, reapplyDate, buildApplicantNotification } = await import("./courierApplication.utils.js");
const { CourierApplicationValidation } = await import("./courierApplication.validation.js");
type Deps = import("./courierApplication.service.js").CourierApplicationDeps;
type StaffNotifyDb = import("../notification/notification.staff.js").StaffNotifyDb;
type PendingEmail = import("../notification/notification.types.js").PendingEmail;

// ───────── In-memory database ─────────

interface UserRow { id: string; name: string; email: string; role: Role; status: UserStatus; deletedAt: Date | null; phone: string | null }
interface AppRow {
  id: string; userId: string; status: CourierApplicationStatus; phone: string; preferredZoneId: string | null;
  vehicleType: VehicleType; vehiclePlate: string | null; availability: WorkAvailability; experience: string | null; about: string | null;
  reviewedById: string | null; reviewedAt: Date | null; reviewNote: string | null; createdAt: Date; updatedAt: Date;
}
interface State {
  users: UserRow[];
  apps: AppRow[];
  zones: { id: string; name: string; isActive: boolean; deletedAt: Date | null }[];
  profiles: { id: string; userId: string; zoneId: string; hubId: string | null; vehicleType: VehicleType; vehicleNumber: string | null; deletedAt: Date | null; isAvailable: boolean }[];
  sessions: { id: string; userId: string }[];
  notifications: { id: string; userId: string; type: string; title: string; message: string; link: string | null; dedupeKey: string | null }[];
  audits: { action: string; entityType: string; entityId: string; after: unknown }[];
  /** userId → unfinished shipments (assertNoActiveWork). */
  activeShipments: Record<string, number>;
}

const ADMIN = { id: "u-admin", role: Role.ADMIN };
const ZONE_CHI = "019a0000-0000-7000-8000-00000000c41c";
const ZONE_DET = "019a0000-0000-7000-8000-00000000de70";
const NOW = new Date("2026-11-11T15:00:00Z");
const META = { ipAddress: "127.0.0.1", userAgent: "test" };

const initialState = (): State => ({
  users: [
    { id: "u-admin", name: "Carrivo Admin", email: "admin@carrivo.dev", role: Role.ADMIN, status: UserStatus.ACTIVE, deletedAt: null, phone: null },
    { id: "u-viewer", name: "Carrivo Viewer", email: "viewer@carrivo.dev", role: Role.ADMIN_VIEWER, status: UserStatus.ACTIVE, deletedAt: null, phone: null },
    { id: "u-cust", name: "Jordan Lee", email: "jordan@example.com", role: Role.CUSTOMER, status: UserStatus.ACTIVE, deletedAt: null, phone: null },
    { id: "u-cust2", name: "Avery Brooks", email: "avery@example.com", role: Role.CUSTOMER, status: UserStatus.ACTIVE, deletedAt: null, phone: "(312) 555-0150" },
    { id: "u-courier", name: "Marcus Johnson", email: "courier1@carrivo.dev", role: Role.COURIER, status: UserStatus.ACTIVE, deletedAt: null, phone: null },
  ],
  apps: [],
  zones: [
    { id: ZONE_CHI, name: "Chicago Metro", isActive: true, deletedAt: null },
    { id: ZONE_DET, name: "Detroit Metro", isActive: true, deletedAt: null },
  ],
  profiles: [],
  sessions: [
    { id: "s1", userId: "u-cust" },
    { id: "s2", userId: "u-cust" },
    { id: "s3", userId: "u-admin" },
  ],
  notifications: [],
  audits: [],
  activeShipments: {},
});

const p2002 = () => new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" });
type Where = Record<string, unknown>;

/**
 * Implements exactly the queries the service (and AdminUserRules) send. Transactions run one at a
 * time (like the row locks they take) and roll the whole state back when the callback throws.
 */
const createFakeDb = (state: State, options: { failOn?: string } = {}) => {
  let seq = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const fail = (step: string) => {
    if (options.failOn === step) throw new Error(`injected failure at ${step}`);
  };
  const appMatches = (row: AppRow, where: Where): boolean =>
    (where["id"] === undefined || row.id === where["id"]) &&
    (where["userId"] === undefined || row.userId === where["userId"]) &&
    (where["status"] === undefined || row.status === where["status"]);
  const withRelations = (row: AppRow) => ({
    ...row,
    preferredZone: state.zones.find((z) => z.id === row.preferredZoneId) ?? null,
    user: state.users.find((u) => u.id === row.userId),
    reviewedBy: state.users.find((u) => u.id === row.reviewedById) ?? null,
  });
  const newest = (rows: AppRow[]) => [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (b.id > a.id ? 1 : -1));

  const courierApplication = {
    findFirst: async ({ where, orderBy }: { where: Where; orderBy?: unknown }) => {
      const rows = state.apps.filter((r) => appMatches(r, where));
      const sorted = JSON.stringify(orderBy ?? "").includes("reviewedAt")
        ? [...rows].sort((a, b) => (b.reviewedAt?.getTime() ?? 0) - (a.reviewedAt?.getTime() ?? 0))
        : newest(rows);
      return sorted[0] ? withRelations(sorted[0]) : null;
    },
    findMany: async ({ where, take }: { where: Where; take?: number }) => newest(state.apps.filter((r) => appMatches(r, where))).slice(0, take).map(withRelations),
    count: async ({ where }: { where: Where }) => state.apps.filter((r) => appMatches(r, where)).length,
    findUnique: async ({ where }: { where: { id: string } }) => {
      const row = state.apps.find((r) => r.id === where.id);
      return row ? withRelations(row) : null;
    },
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
      const row = state.apps.find((r) => r.id === where.id);
      if (!row) throw new Error("not found");
      return withRelations(row);
    },
    create: async ({ data }: { data: Omit<AppRow, "id" | "status" | "reviewedById" | "reviewedAt" | "reviewNote" | "createdAt" | "updatedAt"> }) => {
      // The partial unique index: one PENDING per user.
      if (state.apps.some((r) => r.userId === data.userId && r.status === CourierApplicationStatus.PENDING)) throw p2002();
      seq += 1;
      const row: AppRow = {
        ...data,
        id: `019a0000-0000-7000-8000-${String(seq).padStart(12, "0")}`,
        status: CourierApplicationStatus.PENDING,
        reviewedById: null,
        reviewedAt: null,
        reviewNote: null,
        createdAt: new Date(NOW.getTime() + seq), // strictly increasing, so "newest" is stable
        updatedAt: NOW,
      };
      state.apps.push(row);
      return withRelations(row);
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<AppRow> }) => {
      fail("application.update");
      const row = state.apps.find((r) => r.id === where.id);
      if (!row) throw new Error("not found");
      Object.assign(row, data, { updatedAt: NOW });
      return withRelations(row);
    },
  };

  const user = {
    findFirst: async ({ where }: { where: { id: string } }) => {
      const row = state.users.find((u) => u.id === where.id && u.deletedAt === null);
      if (!row) return null;
      const profile = state.profiles.find((p) => p.userId === row.id);
      return { ...row, courierProfile: profile ? { id: profile.id, deletedAt: profile.deletedAt } : null };
    },
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
      const row = state.users.find((u) => u.id === where.id);
      if (!row) throw new Error("not found");
      return { ...row };
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<UserRow> }) => {
      fail("user.update");
      const row = state.users.find((u) => u.id === where.id);
      if (!row) throw new Error("not found");
      Object.assign(row, data);
      return { ...row };
    },
  };

  const zone = {
    findFirst: async ({ where }: { where: { id: string } }) => state.zones.find((z) => z.id === where.id && z.isActive && z.deletedAt === null) ?? null,
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
      const row = state.zones.find((z) => z.id === where.id);
      if (!row) throw new Error("not found");
      return row;
    },
  };

  const tx = {
    courierApplication,
    user,
    zone,
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      if (sql.includes(`"courier_applications"`)) {
        const row = state.apps.find((r) => r.id === values[0]);
        return row ? [{ id: row.id, status: row.status, userId: row.userId }] : [];
      }
      if (sql.includes(`"role" = 'ADMIN'`)) {
        return state.users.filter((u) => u.role === Role.ADMIN && u.status === UserStatus.ACTIVE && !u.deletedAt).map((u) => ({ id: u.id }));
      }
      if (sql.includes(`FROM "users" WHERE "id"`)) return [];
      throw new Error(`unexpected raw query: ${sql}`);
    },
    hub: { findFirst: async () => null },
    shipment: {
      count: async ({ where }: { where: Where }) => state.activeShipments[String(where["customerId"] ?? where["courierId"])] ?? 0,
      findMany: async () => [{ trackingId: "CRV-261111-OPEN01" }],
    },
    courierProfile: {
      upsert: async ({ where, create, update }: { where: { userId: string }; create: State["profiles"][number]; update: Partial<State["profiles"][number]> }) => {
        const existing = state.profiles.find((p) => p.userId === where.userId);
        if (existing) Object.assign(existing, update);
        else state.profiles.push({ ...create, id: `cp-${create.userId}` });
        return {};
      },
      update: async () => ({}),
    },
    session: {
      deleteMany: async ({ where }: { where: { userId: string } }) => {
        const before = state.sessions.length;
        state.sessions = state.sessions.filter((s) => s.userId !== where.userId);
        return { count: before - state.sessions.length };
      },
    },
    auditLog: {
      create: async ({ data }: { data: State["audits"][number] }) => {
        state.audits.push({ action: data.action, entityType: data.entityType, entityId: data.entityId, after: data.after });
        return { id: `a${state.audits.length}` };
      },
    },
    notification: {
      createMany: async ({ data, skipDuplicates }: { data: Omit<State["notifications"][number], "id">[]; skipDuplicates: boolean }) => {
        fail("notification.createMany");
        let count = 0;
        for (const row of data) {
          const clash = row.dedupeKey !== null && state.notifications.some((n) => n.dedupeKey === row.dedupeKey);
          if (clash && !skipDuplicates) throw p2002();
          if (clash) continue;
          state.notifications.push({ ...row, id: `n${state.notifications.length + 1}` });
          count += 1;
        }
        return { count };
      },
      findUniqueOrThrow: async ({ where }: { where: { dedupeKey: string } }) => {
        const row = state.notifications.find((n) => n.dedupeKey === where.dedupeKey);
        if (!row) throw new Error("not found");
        return { id: row.id };
      },
    },
  };

  const db = {
    ...tx,
    $transaction: <T>(fn: (client: typeof tx) => Promise<T>): Promise<T> => {
      const run = async (): Promise<T> => {
        const snapshot = structuredClone(state);
        try {
          return await fn(tx);
        } catch (error) {
          Object.assign(state, snapshot); // roll back every change made inside
          throw error;
        }
      };
      const result = queue.then(run, run);
      queue = result.catch(() => undefined);
      return result;
    },
  };
  return db;
};

/** A service on a fresh fake, recording staff notices and queued emails. */
const setup = (options: { failOn?: string; now?: Date } = {}) => {
  const state = initialState();
  const staff: { kind: string; args: unknown[] }[] = [];
  const emails: PendingEmail[] = [];
  const clock = { now: options.now ?? NOW };
  const deps: Deps = {
    db: createFakeDb(state, options) as unknown as Deps["db"],
    now: () => clock.now,
    staff: {
      applicationSubmitted: async (...args) => void staff.push({ kind: "submitted", args }),
      courierAdded: async (...args) => void staff.push({ kind: "courierAdded", args }),
    },
    sendEmails: async (batch) => void emails.push(...batch),
  };
  return { state, staff, emails, clock, service: createCourierApplicationService(deps) };
};

const actor = (id: string, role: Role) => ({ id, role });
const CUSTOMER = actor("u-cust", Role.CUSTOMER);
const FORM = { phone: "(312) 555-0142", preferredZoneId: ZONE_CHI, vehicleType: VehicleType.CAR, vehiclePlate: "IL ABC-1234", availability: WorkAvailability.WEEKDAYS };

const rejects = async (promise: Promise<unknown>, status: number, message?: RegExp) => {
  await assert.rejects(promise, (error: { statusCode?: number; message?: string }) => {
    assert.equal(error.statusCode, status, `expected ${status}, got ${error.statusCode}: ${error.message}`);
    if (message) assert.match(error.message ?? "", message);
    return true;
  });
};

afterEach(() => mock.restoreAll());

// ───────── Pure rules ─────────

describe("eligibility rules", () => {
  it("only customers apply: staff 403, couriers 409", () => {
    assert.equal(roleRefusal(Role.CUSTOMER), null);
    assert.equal(roleRefusal(Role.COURIER)?.status, 409);
    assert.equal(roleRefusal(Role.ADMIN)?.status, 403);
    assert.equal(roleRefusal(Role.ADMIN_VIEWER)?.status, 403);
  });

  it("a pending application blocks a new one", () => {
    const result = checkEligibility({ role: Role.CUSTOMER, pending: { createdAt: NOW }, lastRejectedAt: null, now: NOW });
    assert.equal(result.canApply, false);
    assert.equal(result.refusal?.status, 409);
    assert.match(result.refusal?.message ?? "", /pending application from Nov 11, 2026/);
  });

  it(`after a rejection, waits exactly ${REAPPLY_COOLDOWN_DAYS} days and names the date`, () => {
    const rejectedAt = new Date("2026-11-04T16:00:00Z");
    const until = reapplyDate(rejectedAt);
    assert.equal(until.getTime() - rejectedAt.getTime(), REAPPLY_COOLDOWN_DAYS * DAY_MS);
    const early = checkEligibility({ role: Role.CUSTOMER, pending: null, lastRejectedAt: rejectedAt, now: new Date(until.getTime() - 1) });
    assert.equal(early.canApply, false);
    assert.deepEqual(early.canReapplyAt, until);
    assert.match(early.refusal?.message ?? "", /apply again on Nov 11, 2026/);
    const onTime = checkEligibility({ role: Role.CUSTOMER, pending: null, lastRejectedAt: rejectedAt, now: until });
    assert.deepEqual(onTime, { canApply: true, canReapplyAt: null, refusal: null });
  });
});

describe("validation", () => {
  const parse = (body: unknown) => CourierApplicationValidation.apply.safeParse({ body });

  it("accepts the form and normalizes the plate", () => {
    const result = parse({ ...FORM, vehiclePlate: " il abc-1234 ", experience: "  " });
    assert.ok(result.success);
    assert.equal(result.data.body.vehiclePlate, "IL ABC-1234");
    assert.equal(result.data.body.experience, null);
  });

  it("refuses government IDs and other unknown fields", () => {
    for (const key of ["licenseNumber", "driverLicense", "ssn", "role"]) {
      assert.equal(parse({ ...FORM, [key]: "123-45-6789" }).success, false, key);
    }
  });

  it("enforces US phones, the existing vehicle enum and text caps", () => {
    assert.equal(parse({ ...FORM, phone: "+44 20 7946 0958" }).success, false);
    assert.equal(parse({ ...FORM, vehicleType: "SCOOTER" }).success, false);
    assert.equal(parse({ ...FORM, about: "x".repeat(1001) }).success, false);
    assert.equal(parse({ ...FORM, experience: "x".repeat(501) }).success, false);
  });

  it("reject needs a note (max 500); approve takes an optional zone/hub only", () => {
    const params = { id: "019a0000-0000-7000-8000-000000000001" };
    assert.equal(CourierApplicationValidation.reject.safeParse({ params, body: {} }).success, false);
    assert.equal(CourierApplicationValidation.reject.safeParse({ params, body: { note: "  " } }).success, false);
    assert.equal(CourierApplicationValidation.reject.safeParse({ params, body: { note: "x".repeat(501) } }).success, false);
    assert.ok(CourierApplicationValidation.reject.safeParse({ params, body: { note: "No vehicle insurance on file" } }).success);
    const approve = CourierApplicationValidation.approve.safeParse({ params, body: undefined });
    assert.ok(approve.success);
    assert.deepEqual(approve.data.body, {});
    assert.equal(CourierApplicationValidation.approve.safeParse({ params, body: { role: "ADMIN" } }).success, false);
  });
});

// ───────── Service ─────────

describe("apply", () => {
  it("creates a PENDING application, audits it and notifies staff once", async () => {
    const { service, state, staff } = setup();
    const app = await service.apply(CUSTOMER, FORM, META);
    assert.equal(app.status, CourierApplicationStatus.PENDING);
    assert.equal(state.apps.length, 1);
    assert.deepEqual(state.audits.map((a) => a.action), ["COURIER_APPLICATION_SUBMITTED"]);
    assert.equal(staff.length, 1);
    assert.deepEqual(staff[0]?.args, [{ id: app.id, vehicleType: VehicleType.CAR, zoneName: "Chicago Metro" }, { name: "Jordan Lee", email: "jordan@example.com" }]);
  });

  it("only CUSTOMER can apply (service check, besides the route guard)", async () => {
    const { service, state } = setup();
    await rejects(service.apply(actor("u-admin", Role.ADMIN), FORM, META), 403, /Staff accounts/);
    await rejects(service.apply(actor("u-viewer", Role.ADMIN_VIEWER), FORM, META), 403);
    await rejects(service.apply(actor("u-courier", Role.COURIER), FORM, META), 409, /already a courier/);
    assert.equal(state.apps.length, 0);
  });

  it("blocks a second PENDING application (409)", async () => {
    const { service, state } = setup();
    await service.apply(CUSTOMER, FORM, META);
    await rejects(service.apply(CUSTOMER, FORM, META), 409, /pending application/);
    assert.equal(state.apps.length, 1);
  });

  it("two simultaneous submits: the DB's one-pending index turns the loser into a 409", async () => {
    const { service, state } = setup();
    const results = await Promise.allSettled([service.apply(CUSTOMER, FORM, META), service.apply(CUSTOMER, FORM, META)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const loser = results.find((r) => r.status === "rejected");
    assert.equal((loser as PromiseRejectedResult).reason.statusCode, 409);
    assert.equal(state.apps.filter((a) => a.status === CourierApplicationStatus.PENDING).length, 1);
  });

  it(`after a rejection: 409 with the reapply date for ${REAPPLY_COOLDOWN_DAYS} days, then allowed`, async () => {
    const { service, clock } = setup();
    const first = await service.apply(CUSTOMER, FORM, META);
    await service.reject(ADMIN, first.id, { note: "Please add your vehicle plate" }, META);
    clock.now = new Date(NOW.getTime() + 3 * DAY_MS);
    await assert.rejects(service.apply(CUSTOMER, FORM, META), (error: { statusCode: number; message: string; errors: { path: string; message: string }[] }) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /You can apply again on Nov 18, 2026/);
      assert.deepEqual(error.errors, [{ path: "canReapplyAt", message: reapplyDate(NOW).toISOString() }]);
      return true;
    });
    const mine = await service.getMine(CUSTOMER);
    assert.equal(mine.canApply, false);
    assert.deepEqual(mine.canReapplyAt, reapplyDate(NOW));
    assert.equal(mine.latest?.reviewNote, "Please add your vehicle plate");
    clock.now = reapplyDate(NOW);
    const second = await service.apply(CUSTOMER, FORM, META);
    assert.equal(second.status, CourierApplicationStatus.PENDING);
  });

  it("a cancelled application doesn't start a cooldown", async () => {
    const { service } = setup();
    const first = await service.apply(CUSTOMER, FORM, META);
    await service.cancelMine(CUSTOMER, first.id, META);
    const again = await service.apply(CUSTOMER, FORM, META);
    assert.notEqual(again.id, first.id);
  });

  it("refuses an inactive or unknown preferred zone (400)", async () => {
    const { service, state } = setup();
    state.zones[0]!.isActive = false;
    await rejects(service.apply(CUSTOMER, FORM, META), 400, /Zone not found or inactive/);
  });
});

describe("cancel (owner only, PENDING only)", () => {
  it("another user's application is invisible (404)", async () => {
    const { service, state } = setup();
    const app = await service.apply(CUSTOMER, FORM, META);
    await rejects(service.cancelMine(actor("u-cust2", Role.CUSTOMER), app.id, META), 404);
    assert.equal(state.apps[0]?.status, CourierApplicationStatus.PENDING);
  });

  it("cancels a pending one; a decided one gets 409 with its status", async () => {
    const { service, state } = setup();
    const app = await service.apply(CUSTOMER, FORM, META);
    const cancelled = await service.cancelMine(CUSTOMER, app.id, META);
    assert.equal(cancelled.status, CourierApplicationStatus.CANCELLED);
    await rejects(service.cancelMine(CUSTOMER, app.id, META), 409, /This one is CANCELLED/);
    assert.equal(state.audits.filter((a) => a.action === "COURIER_APPLICATION_CANCELLED").length, 1);
  });
});

describe("approve", () => {
  it("makes the customer a COURIER with a profile in the preferred zone, revokes sessions and notifies", async () => {
    const { service, state, staff, emails } = setup();
    const app = await service.apply(CUSTOMER, FORM, META);
    const result = await service.approve(ADMIN, app.id, {}, META);

    assert.equal(result.status, CourierApplicationStatus.APPROVED);
    assert.equal(result.reviewedBy?.id, "u-admin");
    const user = state.users.find((u) => u.id === "u-cust")!;
    assert.equal(user.role, Role.COURIER);
    assert.equal(user.phone, FORM.phone, "empty account phone filled from the application");
    assert.deepEqual(
      state.profiles.map(({ userId, zoneId, hubId, vehicleType, vehicleNumber, isAvailable, deletedAt }) => ({ userId, zoneId, hubId, vehicleType, vehicleNumber, isAvailable, deletedAt })),
      [{ userId: "u-cust", zoneId: ZONE_CHI, hubId: null, vehicleType: VehicleType.CAR, vehicleNumber: "IL ABC-1234", isAvailable: true, deletedAt: null }],
    );
    assert.deepEqual(state.sessions.map((s) => s.id), ["s3"], "only the applicant's sessions are revoked");
    assert.deepEqual(state.audits.map((a) => a.action), ["COURIER_APPLICATION_SUBMITTED", "COURIER_APPLICATION_APPROVED", "USER_ROLE_CHANGED"]);

    const notice = state.notifications.find((n) => n.userId === "u-cust")!;
    assert.equal(notice.type, "COURIER_APPLICATION_APPROVED");
    assert.match(notice.message, /You are now a courier: please sign in again/);
    assert.equal(notice.link, "/dashboard");
    assert.equal(notice.dedupeKey, `COURIER_APPLICATION_APPROVED:application:${app.id}:u-cust`);
    assert.equal(emails.length, 1);
    assert.equal(emails[0]?.to, "jordan@example.com");
    assert.deepEqual(staff.find((s) => s.kind === "courierAdded")?.args.slice(1), ["application", ADMIN, app.id]);
  });

  it("keeps an existing account phone, and an admin zone override wins", async () => {
    const { service, state } = setup();
    const avery = actor("u-cust2", Role.CUSTOMER);
    const app = await service.apply(avery, { ...FORM, preferredZoneId: null }, META);
    await rejects(service.approve(ADMIN, app.id, {}, META), 400, /Choose a zone/);
    await service.approve(ADMIN, app.id, { zoneId: ZONE_DET }, META);
    assert.equal(state.users.find((u) => u.id === "u-cust2")?.phone, "(312) 555-0150");
    assert.equal(state.profiles[0]?.zoneId, ZONE_DET);
  });

  it("is idempotent: a second approve is a 409 naming the status, and changes nothing", async () => {
    const { service, state, staff, emails } = setup();
    const app = await service.apply(CUSTOMER, FORM, META);
    await service.approve(ADMIN, app.id, {}, META);
    const snapshot = structuredClone(state);
    await assert.rejects(service.approve(ADMIN, app.id, {}, META), (error: { statusCode: number; errors: unknown[] }) => {
      assert.equal(error.statusCode, 409);
      assert.deepEqual(error.errors, [{ path: "status", message: "APPROVED" }]);
      return true;
    });
    await rejects(service.reject(ADMIN, app.id, { note: "Too late" }, META), 409, /This one is APPROVED/);
    assert.deepEqual(state, snapshot);
    assert.equal(staff.filter((s) => s.kind === "courierAdded").length, 1);
    assert.equal(emails.length, 1);
  });

  it("two admins approving at once: exactly one succeeds", async () => {
    const { service, state } = setup();
    const app = await service.apply(CUSTOMER, FORM, META);
    const results = await Promise.allSettled([service.approve(ADMIN, app.id, {}, META), service.approve(ADMIN, app.id, {}, META)]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
    assert.equal(state.audits.filter((a) => a.action === "USER_ROLE_CHANGED").length, 1);
    assert.equal(state.notifications.length, 1);
  });

  for (const step of ["user.update", "application.update", "notification.createMany"]) {
    it(`is atomic: a failure at ${step} leaves role, profile, sessions and application untouched`, async () => {
      const { service, state, staff, emails } = setup({ failOn: step });
      const app = await service.apply(CUSTOMER, FORM, META);
      const before = structuredClone(state);
      await assert.rejects(service.approve(ADMIN, app.id, {}, META), /injected failure/);
      assert.deepEqual(state, before);
      assert.equal(state.users.find((u) => u.id === "u-cust")?.role, Role.CUSTOMER);
      assert.equal(state.sessions.filter((s) => s.userId === "u-cust").length, 2);
      assert.equal(staff.filter((s) => s.kind === "courierAdded").length, 0);
      assert.equal(emails.length, 0);
    });
  }

  it("never changes the role of a user who is no longer a CUSTOMER", async () => {
    for (const role of [Role.COURIER, Role.ADMIN, Role.ADMIN_VIEWER]) {
      const { service, state } = setup();
      const app = await service.apply(CUSTOMER, FORM, META);
      state.users.find((u) => u.id === "u-cust")!.role = role; // e.g. promoted by an admin since
      await rejects(service.approve(ADMIN, app.id, {}, META), 409, new RegExp(`already ${role}`));
      assert.equal(state.users.find((u) => u.id === "u-cust")?.role, role);
      assert.equal(state.apps[0]?.status, CourierApplicationStatus.PENDING);
      assert.equal(state.profiles.length, 0);
    }
  });

  it("refuses while the customer still has unfinished shipments (same rule as a role change)", async () => {
    const { service, state } = setup();
    const app = await service.apply(CUSTOMER, FORM, META);
    state.activeShipments["u-cust"] = 2;
    await rejects(service.approve(ADMIN, app.id, {}, META), 409, /Cannot approve this application: 2 active shipment/);
    assert.equal(state.users.find((u) => u.id === "u-cust")?.role, Role.CUSTOMER);
  });

  it("an admin whose access was revoked can't decide", async () => {
    const { service, state } = setup();
    const app = await service.apply(CUSTOMER, FORM, META);
    state.users.find((u) => u.id === "u-admin")!.status = UserStatus.INACTIVE;
    await rejects(service.approve(ADMIN, app.id, {}, META), 403, /admin access has changed/);
    await rejects(service.reject(ADMIN, app.id, { note: "No" }, META), 403);
  });

  it("an unknown id is a 404", async () => {
    const { service } = setup();
    await rejects(service.approve(ADMIN, "019a0000-0000-7000-8000-0000000000ff", {}, META), 404);
  });
});

describe("reject", () => {
  it("records the note, keeps the role, and tells the applicant why and when to reapply", async () => {
    const { service, state, emails } = setup();
    const app = await service.apply(CUSTOMER, FORM, META);
    const result = await service.reject(ADMIN, app.id, { note: "We need a vehicle with insurance" }, META);
    assert.equal(result.status, CourierApplicationStatus.REJECTED);
    assert.equal(result.reviewNote, "We need a vehicle with insurance");
    assert.equal(state.users.find((u) => u.id === "u-cust")?.role, Role.CUSTOMER);
    assert.equal(state.sessions.filter((s) => s.userId === "u-cust").length, 2, "rejection signs nobody out");
    assert.equal(state.profiles.length, 0);
    const notice = state.notifications[0]!;
    assert.equal(notice.type, "COURIER_APPLICATION_REJECTED");
    assert.equal(notice.message, "Your courier application was not approved. Reason: We need a vehicle with insurance. You can apply again on Nov 18, 2026.");
    assert.equal(notice.link, "/courier-application");
    assert.equal(emails.length, 1);
  });

  it("dedupes the applicant notice on application + decision (a replayed notice inserts nothing)", async () => {
    const { service, state, emails } = setup();
    const app = await service.apply(CUSTOMER, FORM, META);
    state.notifications.push({ id: "n-old", userId: "u-cust", type: "COURIER_APPLICATION_REJECTED", title: "t", message: "m", link: null, dedupeKey: `COURIER_APPLICATION_REJECTED:application:${app.id}:u-cust` });
    await service.reject(ADMIN, app.id, { note: "Duplicate check" }, META);
    assert.equal(state.notifications.length, 1);
    assert.equal(emails.length, 0, "no email for a notice that was not inserted");
  });
});

// ───────── Notifications ─────────

describe("notifications", () => {
  it("new application → one row per active ADMIN and ADMIN_VIEWER, deduped on the application", async () => {
    const rows: { userId: string; dedupeKey: string | null; link: string | null; type: string }[] = [];
    const db: StaffNotifyDb = {
      user: { findMany: async () => [{ id: "u-admin" }, { id: "u-viewer" }] },
      notification: {
        createMany: async ({ data }) => {
          let count = 0;
          for (const row of data) {
            if (rows.some((r) => r.dedupeKey === row.dedupeKey)) continue;
            rows.push({ userId: row.userId, dedupeKey: row.dedupeKey ?? null, link: row.link ?? null, type: row.type });
            count += 1;
          }
          return { count };
        },
      },
    };
    const input = buildStaffNotification({
      kind: "COURIER_APPLICATION_SUBMITTED",
      application: { id: "app-1", vehicleType: "MOTORCYCLE", zoneName: "Detroit Metro" },
      applicant: { name: "Jordan Lee", email: "jordan@example.com" },
    });
    assert.equal(input.link, "/admin/courier-applications?status=PENDING");
    assert.match(input.message, /Jordan Lee \(jordan@example.com\) applied to become a courier with a motorcycle, preferring Detroit Metro/);
    assert.deepEqual(await notifyStaff(input, db), { recipients: 2, created: 2 });
    assert.deepEqual(await notifyStaff(input, db), { recipients: 2, created: 0 }, "replay inserts nothing");
    assert.deepEqual(rows.map((r) => r.dedupeKey), ["COURIER_APPLICATION_SUBMITTED:application:app-1:u-admin", "COURIER_APPLICATION_SUBMITTED:application:app-1:u-viewer"]);
  });

  it("an approval tells staff who approved whom, deduped on the application", () => {
    const input = buildStaffNotification({
      kind: "COURIER_ADDED",
      user: { id: "u-cust", name: "Jordan Lee", email: "jordan@example.com" },
      zoneName: "Chicago Metro",
      via: "application",
      actorName: "Carrivo Admin",
      applicationId: "app-1",
    });
    assert.equal(input.message, "Carrivo Admin approved the courier application from Jordan Lee (jordan@example.com). They now work as a courier in Chicago Metro.");
    assert.equal(input.dedupeKey, "COURIER_ADDED:application:app-1");
  });

  it("emails use a matching button and escape the admin's note", () => {
    const content = buildApplicantNotification({ kind: "REJECTED", applicationId: "a", note: "<b>No</b> insurance", reapplyAt: reapplyDate(NOW) });
    const email = renderEmail(content, { recipientName: "Jordan Lee", frontendOrigin: "https://carrivo.example" });
    assert.match(email.html, />View your application</);
    assert.doesNotMatch(email.html, /<b>No<\/b>/);
    assert.match(email.text, /https:\/\/carrivo\.example\/courier-application/);
    const approved = renderEmail(buildApplicantNotification({ kind: "APPROVED", applicationId: "a", zoneName: "Chicago Metro", vehicleType: "CAR" }), {
      recipientName: "Jordan Lee",
      frontendOrigin: "https://carrivo.example",
    });
    assert.match(approved.html, />Sign in as a courier</);
  });
});

// ───────── HTTP: roles through the real routes ─────────

describe("HTTP role checks", () => {
  let base = "";
  let server: ReturnType<typeof app.listen>;
  let role: Role = Role.CUSTOMER;
  const API = "/api/v1";
  const ID = "019a0000-0000-7000-8000-000000000001";

  before(async () => {
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  const as = (next: Role) => {
    role = next;
    mock.method(auth.api, "getSession", async () => ({
      user: { id: `id-${role}`, email: "x@carrivo.dev", name: "X", role, status: "ACTIVE", deletedAt: null },
      session: { id: "s", token: "t", expiresAt: new Date(Date.now() + 3_600_000) },
    }));
  };
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${API}${path}`, {
      method,
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as { message?: string; data?: unknown } };
  };

  it("ADMIN_VIEWER gets the read-only 403 on approve and reject, before the service runs", async () => {
    as(Role.ADMIN_VIEWER);
    const approve = mock.method(CourierApplicationService, "approve", async () => ({}) as never);
    const reject = mock.method(CourierApplicationService, "reject", async () => ({}) as never);
    for (const [path, body] of [[`/admin/courier-applications/${ID}/approve`, {}], [`/admin/courier-applications/${ID}/reject`, { note: "No vehicle" }]] as const) {
      const res = await call("PATCH", path, body);
      assert.equal(res.status, 403, path);
      assert.equal(res.body.message, READ_ONLY_MESSAGE, path);
    }
    assert.equal(approve.mock.callCount() + reject.mock.callCount(), 0);
  });

  it("ADMIN_VIEWER may read the queue and one application", async () => {
    as(Role.ADMIN_VIEWER);
    mock.method(CourierApplicationService, "adminList", async () => ({ data: [], meta: { page: 1, limit: 10, total: 0, totalPages: 0 } }));
    mock.method(CourierApplicationService, "adminGet", async (id: string) => ({ id }) as never);
    assert.equal((await call("GET", "/admin/courier-applications?status=PENDING&searchTerm=jordan")).status, 200);
    assert.equal((await call("GET", `/admin/courier-applications/${ID}`)).status, 200);
  });

  it("ADMIN reaches approve; a customer or courier can't", async () => {
    const approve = mock.method(CourierApplicationService, "approve", async () => ({ id: ID }) as never);
    as(Role.ADMIN);
    assert.equal((await call("PATCH", `/admin/courier-applications/${ID}/approve`)).status, 200);
    for (const next of [Role.CUSTOMER, Role.COURIER]) {
      as(next);
      assert.equal((await call("PATCH", `/admin/courier-applications/${ID}/approve`, {})).status, 403, next);
    }
    assert.equal(approve.mock.callCount(), 1);
  });

  it("POST /courier-applications: staff 403, viewer read-only 403, courier 409, before validation", async () => {
    const apply = mock.method(CourierApplicationService, "apply", async () => ({}) as never);
    as(Role.ADMIN);
    let res = await call("POST", "/courier-applications", {});
    assert.equal(res.status, 403);
    assert.match(res.body.message ?? "", /Staff accounts can't apply/);
    as(Role.ADMIN_VIEWER);
    res = await call("POST", "/courier-applications", {});
    assert.deepEqual([res.status, res.body.message], [403, READ_ONLY_MESSAGE]);
    as(Role.COURIER);
    res = await call("POST", "/courier-applications", {});
    assert.deepEqual([res.status, res.body.message], [409, "You are already a courier"]);
    as(Role.CUSTOMER);
    res = await call("POST", "/courier-applications", { ...FORM, ssn: "123-45-6789" });
    assert.equal(res.status, 400, "a customer reaches validation, which refuses unknown fields");
    assert.equal(apply.mock.callCount(), 0);
  });

  it("the caller's own id goes to the service (never one from the request)", async () => {
    const seen: string[] = [];
    mock.method(CourierApplicationService, "cancelMine", async (who: { id: string }, id: string) => {
      seen.push(`${who.id}:${id}`);
      return { id } as never;
    });
    as(Role.CUSTOMER);
    assert.equal((await call("PATCH", `/courier-applications/my/${ID}/cancel`)).status, 200);
    assert.deepEqual(seen, [`id-CUSTOMER:${ID}`]);
    as(Role.ADMIN);
    assert.equal((await call("PATCH", `/courier-applications/my/${ID}/cancel`)).status, 403);
  });
});
