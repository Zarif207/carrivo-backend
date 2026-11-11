import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { VehicleType } from "../src/generated/prisma/enums.js";
import { phoneSchema } from "../src/app/utils/commonValidation.js";
import { ROSTER, couriersFor, planCourierSeed, zoneKey, type DbZone, type PlannedCourier } from "./seed-couriers.plan.js";
import { runCourierSeed, type CourierSeedDeps } from "./seed-couriers.run.js";
import { checkCourierSeedTarget, courierSeedPhrase } from "./seed-couriers.safety.js";

/** The production zone set (15 zones, as on the live API) plus the local seed's SF and Seattle. */
const LIVE: [code: string, name: string, hubs: number][] = [
  ["NYC", "New York Metro", 2], ["LA", "Los Angeles Metro", 2], ["CHI", "Chicago Metro", 2], ["HOU", "Houston Metro", 2],
  ["DFW", "Dallas–Fort Worth", 1], ["MIA", "Miami Metro", 2], ["ATL", "Atlanta Metro", 2], ["PHX", "Phoenix Metro", 1],
  ["PHL", "Philadelphia Metro", 1], ["WDC", "Washington DC Metro", 1], ["DET", "Detroit Metro", 1], ["GRR", "Grand Rapids Metro", 1],
  ["A2", "Ann Arbor Metro", 1], ["LAN", "Lansing Metro", 1], ["FNT", "Flint Metro", 1],
];
const LOCAL_ONLY: [string, string, number][] = [["SF", "San Francisco Bay Area", 2], ["SEA", "Seattle Metro", 2]];

const zone = ([code, name, hubs]: [string, string, number]): DbZone => ({
  id: `zone-${code}`,
  code,
  name,
  hubs: Array.from({ length: hubs }, (_, i) => ({ id: `hub-${code}-${i}`, code: `HUB-${code}${i ? `-${i}` : ""}` })),
});
const ALL = [...LIVE, ...LOCAL_ONLY].map(zone);
const PROD = LIVE.map(zone);
const BIG = new Set(["NYC", "LA", "CHI", "HOU", "DFW", "MIA"]);

describe("courier roster: names, emails and phones", () => {
  const plan = planCourierSeed(ALL, new Set());
  const couriers = plan.create;

  it("covers every zone with fictional, unique people", () => {
    assert.equal(plan.skippedZones.length, 0);
    assert.equal(plan.unrosteredZones.length, 0);
    assert.equal(new Set(couriers.map((c) => c.name)).size, couriers.length);
  });

  it("emails are first.last.<zonecode>@carrivo.dev, lowercase and unique", () => {
    for (const c of couriers) {
      assert.match(c.email, /^[a-z]+\.[a-z]+\.[a-z0-9]+@carrivo\.dev$/, c.email);
      assert.ok(c.email.endsWith(`.${c.zoneCode.toLowerCase()}@carrivo.dev`));
    }
    assert.equal(new Set(couriers.map((c) => c.email)).size, couriers.length);
    assert.ok(couriers.some((c) => c.email === "lauren.devries.grr@carrivo.dev"), "mixed-case surnames are flattened");
  });

  it("phones are valid US numbers in +1 format, in the fictional 555-01XX range, unique", () => {
    for (const c of couriers) {
      assert.match(c.phone, /^\+1 [2-9]\d{2}-555-01\d{2}$/, c.phone);
      assert.ok(phoneSchema.safeParse(c.phone).success, `${c.phone} passes the API's phone rule`);
    }
    assert.equal(new Set(couriers.map((c) => c.phone)).size, couriers.length);
  });

  it("is deterministic, and a missing zone doesn't shift other zones' phones", () => {
    assert.deepEqual(planCourierSeed(ALL, new Set()), plan);
    const withoutNyc = planCourierSeed(ALL.filter((z) => z.code !== "NYC"), new Set()).create;
    for (const c of withoutNyc) assert.deepEqual(c, couriers.find((x) => x.email === c.email));
  });

  it("vehicles: bicycles only in dense cities, dummy plates, never licence or ID numbers", () => {
    const dense = new Set(ROSTER.filter((r) => r.dense).map((r) => zoneKey(r.name)));
    assert.ok(new Set(couriers.map((c) => c.vehicleType)).size >= 4, "a mix of vehicle types");
    for (const c of couriers) {
      assert.ok(Object.values(VehicleType).includes(c.vehicleType));
      if (c.vehicleType === VehicleType.BICYCLE) {
        assert.ok(dense.has(zoneKey(c.zoneName)), `${c.email}: bicycle outside a dense city`);
        assert.equal(c.vehicleNumber, null);
      } else {
        assert.match(c.vehicleNumber ?? "", /^DEMO-[A-Z0-9]+-\d{2}$/);
      }
      assert.ok(!("licenseNumber" in c));
    }
  });
});

describe("courier roster: counts and hubs", () => {
  it("3 couriers in the six biggest metros, 2 everywhere else", () => {
    const plan = planCourierSeed(ALL, new Set());
    for (const row of plan.perZone) assert.equal(row.planned, BIG.has(row.code) ? 3 : 2, row.zone);
    assert.equal(plan.create.length, 6 * 3 + 11 * 2);
    assert.equal(planCourierSeed(PROD, new Set()).create.length, 6 * 3 + 9 * 2); // 36 on the live zone set
    for (const roster of ROSTER) assert.ok(roster.drivers.length >= couriersFor(roster), roster.name);
  });

  it("spreads each zone's couriers round-robin over its hubs (and allows a zone without hubs)", () => {
    const zones = [zone(["NYC", "New York Metro", 2]), zone(["DFW", "Dallas–Fort Worth", 1]), zone(["SEA", "Seattle Metro", 0])];
    const byZone = (code: string) => planCourierSeed(zones, new Set()).create.filter((c) => c.zoneCode === code);
    assert.deepEqual(byZone("NYC").map((c) => c.hubId), ["hub-NYC-0", "hub-NYC-1", "hub-NYC-0"]);
    assert.deepEqual(byZone("DFW").map((c) => c.hubId), ["hub-DFW-0", "hub-DFW-0", "hub-DFW-0"]);
    assert.deepEqual(byZone("SEA").map((c) => c.hubId), [null, null]);
    for (const c of planCourierSeed(ALL, new Set()).create) {
      if (c.hubId) assert.ok(c.hubId.startsWith(`hub-${c.zoneCode}-`), "a courier's hub is inside its zone");
    }
  });

  it("matches zones by name (dash and 'Metro' variants), skips missing ones and reports unknown ones", () => {
    const zones = [zone(["DFW", "Dallas-Fort Worth Metro", 1]), zone(["BOI", "Boise Metro", 1])];
    const plan = planCourierSeed(zones, new Set());
    assert.deepEqual([...new Set(plan.create.map((c) => c.zoneCode))], ["DFW"]);
    assert.deepEqual(plan.unrosteredZones, ["Boise Metro"]);
    assert.equal(plan.skippedZones.length, ROSTER.length - 1);
    assert.ok(plan.skippedZones.includes("New York Metro"));
  });
});

/** An in-memory database: users by email and a notification counter. */
function fakeDb(zones: DbZone[], seededEmails: string[] = []) {
  const users = new Map<string, PlannedCourier | "pre-existing">(seededEmails.map((e) => [e, "pre-existing"]));
  let notifications = 7;
  const calls: string[] = [];
  const deps: CourierSeedDeps = {
    loadZones: async () => zones,
    existingEmails: async (emails) => new Set(emails.filter((e) => users.has(e))),
    createCourier: async (c) => {
      calls.push(`create ${c.email}`);
      if (users.has(c.email)) throw new Error(`would modify existing user ${c.email}`);
      users.set(c.email, c);
    },
    countNotifications: async () => notifications,
    log: () => undefined,
  };
  return { deps, users, calls, bumpNotifications: () => (notifications += 1) };
}

describe("courier seed run", () => {
  it("is idempotent: the second run creates nothing and never touches existing users", async () => {
    const db = fakeDb(ALL, ["courier1@carrivo.dev", "aaliyah.brooks.nyc@carrivo.dev"]);
    const first = await runCourierSeed(db.deps, { dryRun: false });
    assert.equal(first.created, 39); // one roster email already existed
    assert.equal(first.plan.existing.length, 1);
    assert.equal(db.users.get("aaliyah.brooks.nyc@carrivo.dev"), "pre-existing");
    assert.equal(db.users.get("courier1@carrivo.dev"), "pre-existing"); // the demo courier is untouched

    db.calls.length = 0;
    const second = await runCourierSeed(db.deps, { dryRun: false });
    assert.equal(second.created, 0);
    assert.equal(second.plan.existing.length, 40);
    assert.deepEqual(db.calls, []);
  });

  it("a dry run plans but writes nothing", async () => {
    const db = fakeDb(PROD);
    const result = await runCourierSeed(db.deps, { dryRun: true });
    assert.equal(result.plan.create.length, 36);
    assert.equal(result.created, 0);
    assert.deepEqual(db.calls, []);
  });

  it("creates no notifications, and refuses to report success if any appeared", async () => {
    const db = fakeDb(PROD);
    const result = await runCourierSeed(db.deps, { dryRun: false });
    assert.equal(result.notificationsAfter, result.notificationsBefore);

    const noisy = fakeDb(PROD);
    noisy.deps.createCourier = async () => void noisy.bumpNotifications();
    await assert.rejects(runCourierSeed(noisy.deps, { dryRun: false }), /must not notify anyone/);
  });

  it("the script never goes through the notifying admin path or an email sender", () => {
    const source = ["seed-couriers.ts", "seed-couriers.run.ts", "seed-couriers.plan.ts"]
      .map((file) => readFileSync(new URL(file, import.meta.url), "utf8"))
      .join("\n")
      // Comments explain what is avoided; only code counts.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    for (const banned of ["StaffNotify", "NotificationService", "AdminService", "createUser(", "sendEmail", "resend", "sendVerificationEmail", "notification.create"]) {
      assert.ok(!source.includes(banned), `uses ${banned}`);
    }
    assert.ok(source.includes("AdminUserRules.upsertCourierProfile"), "the app's courier-profile path");
    assert.ok(source.includes("auth.api.signUpEmail"), "Better Auth credential handling");
  });
});

describe("courier seed guards", () => {
  const LOCAL = "postgresql://u:p@localhost:55432/carrivo_dev";
  const REMOTE = "postgresql://u:p@ep-example.us-east-2.aws.neon.tech/neondb";
  const base = { confirmPhrase: undefined, loginPassword: undefined, dryRun: false };

  it("always needs SEED_CONFIRM_DB_HOST to match the database host", () => {
    assert.equal(checkCourierSeedTarget({ ...base, databaseUrl: LOCAL, confirmHost: undefined }).ok, false);
    assert.equal(checkCourierSeedTarget({ ...base, databaseUrl: LOCAL, confirmHost: "other-host", dryRun: true }).ok, false);
    assert.deepEqual(checkCourierSeedTarget({ ...base, databaseUrl: LOCAL, confirmHost: "localhost" }), { ok: true, host: "localhost", local: true });
  });

  it("a non-local database needs the typed phrase to write (a dry run doesn't)", () => {
    const host = "ep-example.us-east-2.aws.neon.tech";
    const refused = checkCourierSeedTarget({ ...base, databaseUrl: REMOTE, confirmHost: host });
    assert.equal(refused.ok, false);
    assert.equal(checkCourierSeedTarget({ ...base, databaseUrl: REMOTE, confirmHost: host, confirmPhrase: "seed couriers on localhost" }).ok, false);
    assert.equal(checkCourierSeedTarget({ ...base, databaseUrl: REMOTE, confirmHost: host, confirmPhrase: courierSeedPhrase(host) }).ok, true);
    assert.equal(checkCourierSeedTarget({ ...base, databaseUrl: REMOTE, confirmHost: host, dryRun: true }).ok, true);
  });

  it("an optional login password must be strong off localhost, and is never echoed", () => {
    const host = "ep-example.us-east-2.aws.neon.tech";
    const remote = { ...base, databaseUrl: REMOTE, confirmHost: host, confirmPhrase: courierSeedPhrase(host) };
    const weak = checkCourierSeedTarget({ ...remote, loginPassword: "Shortpw1" });
    assert.equal(weak.ok, false);
    assert.ok(!weak.ok && !weak.reason.includes("Shortpw1"));
    assert.equal(checkCourierSeedTarget({ ...base, databaseUrl: LOCAL, confirmHost: "localhost", loginPassword: "Shortpw1" }).ok, true);
  });
});
