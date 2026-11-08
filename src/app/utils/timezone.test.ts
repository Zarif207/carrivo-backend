import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUSINESS_TIMEZONE, formatBusinessDateTime, zonedTimeToUtc } from "./timezone.js";

describe("zonedTimeToUtc (America/New_York)", () => {
  it("is the business zone", () => assert.equal(BUSINESS_TIMEZONE, "America/New_York"));

  it("uses UTC-5 in winter and UTC-4 in summer", () => {
    assert.equal(zonedTimeToUtc("2026-01-15", "00:00:00.000").toISOString(), "2026-01-15T05:00:00.000Z");
    assert.equal(zonedTimeToUtc("2026-07-15", "23:59:59.999").toISOString(), "2026-07-16T03:59:59.999Z");
  });

  it("handles the DST change days", () => {
    // 2026-03-08: clocks jump 02:00 -> 03:00. Midnight is still EST; end of day is EDT.
    assert.equal(zonedTimeToUtc("2026-03-08", "00:00:00.000").toISOString(), "2026-03-08T05:00:00.000Z");
    assert.equal(zonedTimeToUtc("2026-03-08", "23:59:59.999").toISOString(), "2026-03-09T03:59:59.999Z");
    // 2026-11-01: clocks fall back 02:00 -> 01:00. Midnight is EDT; end of day is EST.
    assert.equal(zonedTimeToUtc("2026-11-01", "00:00:00.000").toISOString(), "2026-11-01T04:00:00.000Z");
    assert.equal(zonedTimeToUtc("2026-11-01", "23:59:59.999").toISOString(), "2026-11-02T04:59:59.999Z");
  });
});

describe("formatBusinessDateTime", () => {
  it("shows New York time with EST / EDT", () => {
    assert.equal(formatBusinessDateTime(new Date("2026-11-06T09:15:00Z")), "Nov 6, 2026, 4:15 AM EST");
    assert.equal(formatBusinessDateTime(new Date("2026-07-04T16:30:00Z")), "Jul 4, 2026, 12:30 PM EDT");
  });
});
