import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma } from "../../generated/prisma/client.js";
import { formatMoney, formatMoneyFields, fromMinorUnits, toMinorUnits } from "./money.js";

describe("formatMoney", () => {
  it("always returns 2 decimals", () => {
    assert.equal(formatMoney(new Prisma.Decimal("160")), "160.00");
    assert.equal(formatMoney(new Prisma.Decimal("120.5")), "120.50");
    assert.equal(formatMoney(new Prisma.Decimal("99.99")), "99.99");
    assert.equal(formatMoney(0), "0.00");
    assert.equal(formatMoney("1500"), "1500.00");
  });

  it("rounds half up", () => {
    assert.equal(formatMoney("10.005"), "10.01");
    assert.equal(formatMoney("10.004"), "10.00");
  });

  it("keeps large amounts exact (no float artefacts)", () => {
    assert.equal(formatMoney(new Prisma.Decimal("99999999.99")), "99999999.99");
    assert.equal(formatMoney(new Prisma.Decimal("0.1").plus("0.2")), "0.30");
  });
});

describe("formatMoneyFields", () => {
  it("formats only the listed Decimal fields and keeps null as null", () => {
    const row = {
      id: "s1",
      price: new Prisma.Decimal("160"),
      declaredValue: null as Prisma.Decimal | null,
      weightLb: new Prisma.Decimal("2.3"),
    };
    const out = formatMoneyFields(row, ["price", "declaredValue"]);
    assert.equal(out.price, "160.00");
    assert.equal(out.declaredValue, null);
    assert.equal(out.id, "s1");
    // Weights are not money and are left untouched.
    assert.ok(out.weightLb instanceof Prisma.Decimal);
    // The JSON a client receives:
    assert.equal(JSON.stringify(out), '{"id":"s1","price":"160.00","declaredValue":null,"weightLb":"2.3"}');
  });

  it("does not mutate the input row", () => {
    const row = { price: new Prisma.Decimal("5") };
    formatMoneyFields(row, ["price"]);
    assert.ok(row.price instanceof Prisma.Decimal);
  });
});

describe("minor units (cents) at the Stripe boundary", () => {
  it("converts dollars to integer cents with Decimal math", () => {
    assert.equal(toMinorUnits(new Prisma.Decimal("6.00")), 600);
    assert.equal(toMinorUnits("4.75"), 475);
    assert.equal(toMinorUnits("0.29"), 29); // 0.29 * 100 is 28.999999999999996 with floats
    assert.equal(toMinorUnits(new Prisma.Decimal("1.1").plus("2.2")), 330);
    assert.equal(toMinorUnits(0), 0);
  });

  it("rejects sub-cent, negative and unsafe amounts", () => {
    assert.throws(() => toMinorUnits("1.005"), RangeError);
    assert.throws(() => toMinorUnits("-1.00"), RangeError);
    assert.throws(() => toMinorUnits("1e20"), RangeError);
  });

  it("converts cents back to a Decimal", () => {
    assert.equal(fromMinorUnits(600).toFixed(2), "6.00");
    assert.equal(fromMinorUnits(29).toFixed(2), "0.29");
    assert.throws(() => fromMinorUnits(1.5), RangeError);
  });
});
