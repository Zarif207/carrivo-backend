import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma } from "../../generated/prisma/client.js";
import { formatMoney, formatMoneyFields } from "./money.js";

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
      weightKg: new Prisma.Decimal("2.3"),
    };
    const out = formatMoneyFields(row, ["price", "declaredValue"]);
    assert.equal(out.price, "160.00");
    assert.equal(out.declaredValue, null);
    assert.equal(out.id, "s1");
    // Weights are not money and are left untouched.
    assert.ok(out.weightKg instanceof Prisma.Decimal);
    // The JSON a client receives:
    assert.equal(JSON.stringify(out), '{"id":"s1","price":"160.00","declaredValue":null,"weightKg":"2.3"}');
  });

  it("does not mutate the input row", () => {
    const row = { price: new Prisma.Decimal("5") };
    formatMoneyFields(row, ["price"]);
    assert.ok(row.price instanceof Prisma.Decimal);
  });
});
