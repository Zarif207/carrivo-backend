import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma } from "../../../generated/prisma/client.js";
import { ApiError } from "../../utils/ApiError.js";
import { TRACKING_ID_PATTERN } from "./shipment.constants.js";
import { formatTrackingDate, generateTrackingId, withTrackingIdRetry } from "./shipment.utils.js";

const p2002 = (fields: string[]): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: { target: fields },
  });

/** Same P2002 shape the pg driver adapter produces. */
const p2002Adapter = (fields: string[]): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: { modelName: "Shipment", driverAdapterError: { cause: { kind: "UniqueConstraintViolation", constraint: { fields } } } },
  });

/** Shape the pg adapter produces inside an interactive transaction (index name, no fields). */
const p2002Index = (index: string, table = "shipments"): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: {
      modelName: "Shipment",
      driverAdapterError: { cause: { kind: "UniqueConstraintViolation", constraint: { index }, table } },
    },
  });

describe("generateTrackingId", () => {
  it("matches CRV-YYMMDD-XXXXXX", () => {
    for (let i = 0; i < 200; i += 1) assert.match(generateTrackingId(), TRACKING_ID_PATTERN);
  });

  it("uses the US Eastern date (America/New_York, DST-aware)", () => {
    // Winter (EST, UTC-5): 04:59 UTC on Nov 6 is still Nov 5 in New York; 05:00 UTC is Nov 6.
    assert.equal(formatTrackingDate(new Date("2026-11-06T04:59:59Z")), "261105");
    assert.equal(formatTrackingDate(new Date("2026-11-06T05:00:00Z")), "261106");
    // Summer (EDT, UTC-4): the day changes at 04:00 UTC.
    assert.equal(formatTrackingDate(new Date("2026-07-04T03:59:59Z")), "260703");
    assert.equal(formatTrackingDate(new Date("2026-07-04T04:00:00Z")), "260704");
  });

  it("maps random bytes onto the look-alike-free alphabet", () => {
    const id = generateTrackingId(new Date("2026-01-02T17:00:00Z"), () => Uint8Array.from([0, 31, 32, 255, 8, 9]));
    assert.equal(id, "CRV-260102-2Z2ZAB");
    assert.doesNotMatch(id.slice(-6), /[01OI]/);
  });
});

describe("withTrackingIdRetry", () => {
  it("retries a trackingId collision with a new id", async () => {
    const ids = ["CRV-1", "CRV-2", "CRV-3"];
    const seen: string[] = [];
    const result = await withTrackingIdRetry(
      async (id) => {
        seen.push(id);
        if (seen.length < 3) throw seen.length === 1 ? p2002(["trackingId"]) : p2002Adapter(["trackingId"]);
        return id;
      },
      () => ids.shift() ?? "none",
    );
    assert.equal(result, "CRV-3");
    assert.deepEqual(seen, ["CRV-1", "CRV-2", "CRV-3"]);
  });

  it("recognises the index-name shape used inside interactive transactions", async () => {
    let calls = 0;
    const result = await withTrackingIdRetry(
      async (id) => {
        calls += 1;
        if (calls === 1) throw p2002Index("shipments_trackingId_key");
        return id;
      },
      () => `CRV-${calls}`,
    );
    assert.equal(calls, 2);
    assert.equal(result, "CRV-1");
  });

  it("does NOT retry an index-name violation on another unique column", async () => {
    let calls = 0;
    const error = p2002Index("zones_code_key", "zones");
    await assert.rejects(
      withTrackingIdRetry(async () => {
        calls += 1;
        throw error;
      }),
      (thrown) => thrown === error,
    );
    assert.equal(calls, 1);
  });

  it("does NOT retry a unique violation on another field", async () => {
    let calls = 0;
    const error = p2002Adapter(["id"]);
    await assert.rejects(
      withTrackingIdRetry(async () => {
        calls += 1;
        throw error;
      }),
      (thrown) => thrown === error,
    );
    assert.equal(calls, 1);
  });

  it("does NOT retry other errors", async () => {
    let calls = 0;
    await assert.rejects(
      withTrackingIdRetry(async () => {
        calls += 1;
        throw new ApiError(400, "bad");
      }),
      ApiError,
    );
    assert.equal(calls, 1);
  });

  it("gives up with 503 after the max attempts", async () => {
    let calls = 0;
    await assert.rejects(
      withTrackingIdRetry(
        async () => {
          calls += 1;
          throw p2002(["trackingId"]);
        },
        () => "CRV-X",
        3,
      ),
      (thrown) => thrown instanceof ApiError && thrown.statusCode === 503,
    );
    assert.equal(calls, 3);
  });
});
