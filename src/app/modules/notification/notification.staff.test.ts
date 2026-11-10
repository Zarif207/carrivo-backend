import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import type { Prisma } from "../../../generated/prisma/client.js";
import { EmailStatus, Role, UserStatus } from "../../../generated/prisma/enums.js";

// No database in unit tests: every call below passes an in-memory fake. Point the default
// client at a closed local port anyway, so an accidental real query can never reach a shared DB.
process.env["DATABASE_URL"] = "postgresql://test@127.0.0.1:1/none";
process.env["DIRECT_URL"] = "postgresql://test@127.0.0.1:1/none";
process.env["UPSTASH_REDIS_REST_URL"] = "";
process.env["UPSTASH_REDIS_REST_TOKEN"] = "";

const { notifyStaff, staffRows, STAFF_RECIPIENT_WHERE, STAFF_EMAIL_NOTE } = await import("./notification.staff.js");
const { buildStaffNotification } = await import("./notification.staff.utils.js");
type StaffNotifyDb = import("./notification.staff.js").StaffNotifyDb;

interface FakeUser {
  id: string;
  role: Role;
  status: UserStatus;
  deletedAt: Date | null;
}

const USERS: FakeUser[] = [
  { id: "admin-1", role: Role.ADMIN, status: UserStatus.ACTIVE, deletedAt: null },
  { id: "admin-2", role: Role.ADMIN, status: UserStatus.ACTIVE, deletedAt: null },
  { id: "viewer-1", role: Role.ADMIN_VIEWER, status: UserStatus.ACTIVE, deletedAt: null },
  { id: "admin-inactive", role: Role.ADMIN, status: UserStatus.INACTIVE, deletedAt: null },
  { id: "admin-deleted", role: Role.ADMIN, status: UserStatus.ACTIVE, deletedAt: new Date("2026-11-01T00:00:00Z") },
  { id: "viewer-inactive", role: Role.ADMIN_VIEWER, status: UserStatus.INACTIVE, deletedAt: null },
  { id: "customer-1", role: Role.CUSTOMER, status: UserStatus.ACTIVE, deletedAt: null },
  { id: "courier-1", role: Role.COURIER, status: UserStatus.ACTIVE, deletedAt: null },
];

/**
 * Interprets exactly the where clause notifyStaff sends (and fails on anything else), and
 * enforces the unique dedupeKey like the real index: createMany + skipDuplicates.
 */
const fakeDb = (users: FakeUser[] = USERS) => {
  const rows: Prisma.NotificationCreateManyInput[] = [];
  const db: StaffNotifyDb = {
    user: {
      findMany: async ({ where }) => {
        assert.deepEqual(Object.keys(where).sort(), ["deletedAt", "role", "status"], "unexpected recipient filter");
        const roles = (where.role as { in: Role[] }).in;
        return users
          .filter((u) => roles.includes(u.role) && u.status === where.status && u.deletedAt === where.deletedAt)
          .map((u) => ({ id: u.id }));
      },
    },
    notification: {
      createMany: async ({ data, skipDuplicates }) => {
        let count = 0;
        for (const row of data) {
          const clash = row.dedupeKey != null && rows.some((r) => r.dedupeKey === row.dedupeKey);
          if (clash && !skipDuplicates) throw new Error("Unique constraint failed on dedupeKey");
          if (clash) continue;
          rows.push(row);
          count += 1;
        }
        return { count };
      },
    },
  };
  return { db, rows };
};

const SHIPMENT = { id: "01a1c5d3-0000-7000-8000-000000000001", trackingId: "CRV-261110-AB12CD", route: "New York Metro to Los Angeles Metro", customerName: "Emily Carter" };
const PAYMENT = { paymentId: "pay-1", shipment: { id: SHIPMENT.id, trackingId: SHIPMENT.trackingId }, amount: "24.50", currency: "usd" };

afterEach(() => mock.restoreAll());

describe("notifyStaff: recipients", () => {
  it("creates one row per active ADMIN and ADMIN_VIEWER, and nobody else", async () => {
    const { db, rows } = fakeDb();
    const result = await notifyStaff({ type: "SHIPMENT_CREATED", title: "t", message: "m", link: "/admin/shipments/x" }, db);
    assert.deepEqual(result, { recipients: 3, created: 3 });
    assert.deepEqual(rows.map((r) => r.userId).sort(), ["admin-1", "admin-2", "viewer-1"]);
  });

  it("never notifies customers or couriers", async () => {
    const { db, rows } = fakeDb();
    await notifyStaff({ type: "DELIVERED", title: "t", message: "m" }, db);
    assert.ok(!rows.some((r) => r.userId === "customer-1" || r.userId === "courier-1"));
  });

  it("skips inactive and deleted admins and viewers", async () => {
    const { db, rows } = fakeDb();
    await notifyStaff({ type: "HUB_CHANGED", title: "t", message: "m" }, db);
    for (const skipped of ["admin-inactive", "admin-deleted", "viewer-inactive"]) {
      assert.ok(!rows.some((r) => r.userId === skipped), skipped);
    }
  });

  it("the recipient filter is ADMIN + ADMIN_VIEWER, ACTIVE, not deleted", () => {
    assert.deepEqual([...STAFF_RECIPIENT_WHERE.role.in].sort(), [Role.ADMIN, Role.ADMIN_VIEWER].sort());
    assert.equal(STAFF_RECIPIENT_WHERE.status, UserStatus.ACTIVE);
    assert.equal(STAFF_RECIPIENT_WHERE.deletedAt, null);
  });

  it("does nothing when there are no staff users", async () => {
    const { db, rows } = fakeDb(USERS.filter((u) => u.role === Role.CUSTOMER));
    assert.deepEqual(await notifyStaff({ type: "DELIVERED", title: "t", message: "m" }, db), { recipients: 0, created: 0 });
    assert.equal(rows.length, 0);
  });
});

describe("notifyStaff: rows", () => {
  it("stores link, shipment, a per-recipient dedupe key, and marks the email as in-app only", () => {
    const [row] = staffRows({ type: "DELIVERED", title: "t", message: "m", link: "/admin/shipments/s1", shipmentId: "s1", dedupeKey: "DELIVERED:shipment:s1" }, ["admin-1"]);
    assert.equal(row?.link, "/admin/shipments/s1");
    assert.equal(row?.shipmentId, "s1");
    assert.equal(row?.dedupeKey, "DELIVERED:shipment:s1:admin-1");
    assert.equal(row?.emailStatus, EmailStatus.SKIPPED);
    assert.equal(row?.emailError, STAFF_EMAIL_NOTE);
  });

  it("falls back to /admin/notifications only when the notice has no link, and has no key without one", () => {
    const [row] = staffRows({ type: "ZONE_CHANGED", title: "t", message: "m" }, ["admin-1"]);
    assert.equal(row?.link, "/admin/notifications");
    assert.equal(row?.dedupeKey, null);
    assert.equal(row?.shipmentId, null);
  });
});

describe("notifyStaff: never throws", () => {
  it("logs and returns zero when the recipient query fails", async () => {
    const warn = mock.method(console, "warn", () => undefined);
    const db: StaffNotifyDb = {
      user: { findMany: async () => Promise.reject(new Error("connection refused")) },
      notification: { createMany: async () => ({ count: 0 }) },
    };
    assert.deepEqual(await notifyStaff({ type: "PAYMENT_FAILED", title: "t", message: "m" }, db), { recipients: 0, created: 0 });
    assert.equal(warn.mock.callCount(), 1);
    assert.match(String(warn.mock.calls[0]?.arguments[0]), /PAYMENT_FAILED skipped: connection refused/);
  });

  it("logs and returns zero when the insert fails", async () => {
    const warn = mock.method(console, "warn", () => undefined);
    const { db } = fakeDb();
    db.notification.createMany = async () => Promise.reject(new Error("deadlock detected"));
    assert.deepEqual(await notifyStaff({ type: "DELIVERED", title: "t", message: "m" }, db), { recipients: 0, created: 0 });
    assert.equal(warn.mock.callCount(), 1);
  });
});

describe("dedupe: webhook replays", () => {
  it("a replayed payment event (or /verify racing the webhook) adds no second row per admin", async () => {
    const { db, rows } = fakeDb();
    const event = { kind: "PAYMENT_RECEIVED", payment: PAYMENT } as const;
    const first = await notifyStaff(buildStaffNotification(event), db);
    const replay = await notifyStaff(buildStaffNotification(event), db);
    assert.deepEqual(first, { recipients: 3, created: 3 });
    assert.deepEqual(replay, { recipients: 3, created: 0 });
    assert.equal(rows.length, 3);
  });

  it("keys payment events on the payment id, so a different payment still notifies", async () => {
    const { db, rows } = fakeDb();
    await notifyStaff(buildStaffNotification({ kind: "PAYMENT_RECEIVED", payment: PAYMENT }), db);
    await notifyStaff(buildStaffNotification({ kind: "PAYMENT_RECEIVED", payment: { ...PAYMENT, paymentId: "pay-2" } }), db);
    assert.equal(rows.length, 6);
    assert.equal(buildStaffNotification({ kind: "PAYMENT_RECEIVED", payment: PAYMENT }).dedupeKey, "PAYMENT_RECEIVED:payment:pay-1");
  });

  it("a replayed refund.failed (same Stripe refund id) dedupes; an API retry that threw always notifies", async () => {
    const { db, rows } = fakeDb();
    const webhook = { kind: "REFUND_FAILED", payment: PAYMENT, reason: "expired_or_canceled_card", attemptKey: "re_123" } as const;
    await notifyStaff(buildStaffNotification(webhook), db);
    await notifyStaff(buildStaffNotification(webhook), db);
    assert.equal(rows.length, 3);
    const retry = { ...webhook, attemptKey: null };
    await notifyStaff(buildStaffNotification(retry), db);
    await notifyStaff(buildStaffNotification(retry), db);
    assert.equal(rows.length, 9);
  });

  it("each failed delivery attempt is its own event", () => {
    const base = { kind: "FAILED_DELIVERY", shipment: SHIPMENT, reason: "Recipient not available", maxAttempts: 3 } as const;
    assert.notEqual(buildStaffNotification({ ...base, attempt: 1 }).dedupeKey, buildStaffNotification({ ...base, attempt: 2 }).dedupeKey);
  });
});

describe("staff notification content", () => {
  // Real frontend admin routes (Carrivo-Frontend/src/app/admin/**/page.tsx).
  const ADMIN_ROUTE = /^\/admin\/(shipments\/[^/?]+|payments(\?.*)?|settings\?tab=(zones|hubs|pricing)|users)$/;

  const events = [
    { kind: "SHIPMENT_CREATED", shipment: SHIPMENT, serviceType: "EXPRESS", amount: "24.50", currency: "usd" },
    { kind: "DELIVERED", shipment: SHIPMENT, courierName: "Marcus Johnson" },
    { kind: "FAILED_DELIVERY", shipment: SHIPMENT, reason: "Recipient not available", attempt: 3, maxAttempts: 3 },
    { kind: "SHIPMENT_CANCELLED", shipment: SHIPMENT, reason: "Customer changed plans", refundPending: true },
    { kind: "PAYMENT_RECEIVED", payment: PAYMENT },
    { kind: "PAYMENT_FAILED", payment: PAYMENT, reason: "Asynchronous payment failed" },
    { kind: "REFUND_COMPLETED", payment: PAYMENT },
    { kind: "REFUND_FAILED", payment: PAYMENT, reason: "insufficient_funds", attemptKey: "re_1" },
    { kind: "ZONE_CHANGED", action: "updated", zone: { id: "z1", code: "DET", name: "Detroit Metro" }, actorName: "Carrivo Admin" },
    { kind: "HUB_CHANGED", action: "created", hub: { id: "h1", code: "HUB-DET", name: "Detroit Central Hub", city: "Detroit" }, actorName: "Carrivo Admin" },
    { kind: "COURIER_ADDED", user: { id: "u1", name: "Sofia Ramirez", email: "courier2@carrivo.dev" }, zoneName: "Los Angeles Metro", via: "role_changed", actorName: "Carrivo Admin" },
  ] as const;

  it("every event links to an existing admin page, never /admin/notifications", () => {
    for (const event of events) {
      const built = buildStaffNotification(event);
      assert.match(built.link ?? "", ADMIN_ROUTE, event.kind);
    }
  });

  it("shipment and payment events carry the shipment id; admin-initiated changes have no dedupe key", () => {
    for (const event of events) {
      const built = buildStaffNotification(event);
      if ("shipment" in event || "payment" in event) assert.equal(built.shipmentId, SHIPMENT.id, event.kind);
      if (event.kind === "ZONE_CHANGED" || event.kind === "HUB_CHANGED" || event.kind === "COURIER_ADDED") assert.equal(built.dedupeKey, null);
    }
  });

  it("uses the agreed links", () => {
    const link = (i: number) => buildStaffNotification(events[i]!).link;
    assert.equal(link(0), `/admin/shipments/${SHIPMENT.id}`);
    assert.equal(link(4), `/admin/shipments/${SHIPMENT.id}`);
    assert.equal(link(5), "/admin/payments?status=FAILED");
    assert.equal(link(6), "/admin/payments?status=REFUNDED");
    assert.equal(link(7), "/admin/payments?requiresReview=true");
    assert.equal(link(8), "/admin/settings?tab=zones");
    assert.equal(link(9), "/admin/settings?tab=hubs");
    assert.equal(link(10), "/admin/users");
  });

  it("writes plain US-formatted operator messages", () => {
    const created = buildStaffNotification(events[0]);
    assert.equal(created.title, "New shipment CRV-261110-AB12CD");
    assert.equal(created.message, "Emily Carter booked an express shipment CRV-261110-AB12CD (New York Metro to Los Angeles Metro) for $24.50 USD. Awaiting payment.");
    assert.match(buildStaffNotification({ ...events[0], serviceType: "SAME_DAY" }).message, /booked a same day shipment/);
    assert.match(buildStaffNotification(events[2]).message, /No attempts left: mark it returned\./);
    assert.match(buildStaffNotification(events[10]).message, /^Carrivo Admin made Sofia Ramirez \(courier2@carrivo\.dev\) a courier in Los Angeles Metro\.$/);
  });
});
