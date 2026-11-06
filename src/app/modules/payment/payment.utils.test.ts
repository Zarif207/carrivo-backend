import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma } from "../../../generated/prisma/client.js";
import { PLATFORM_CURRENCY } from "../../config/currency.js";
import { checkPaidAmount, isHandledStripeEvent, stripeId } from "./payment.utils.js";

const D = (v: string) => new Prisma.Decimal(v);
const base = { expectedAmount: D("6.00"), shipmentPrice: D("6.00"), sessionAmountTotal: 600, sessionCurrency: PLATFORM_CURRENCY };

describe("checkPaidAmount", () => {
  it("accepts an exact match in cents and currency", () => {
    const r = checkPaidAmount(base);
    assert.ok(r.ok);
    assert.equal(r.paidAmount.toFixed(2), "6.00");
  });

  it("rejects a different amount", () => {
    const r = checkPaidAmount({ ...base, sessionAmountTotal: 599 });
    assert.ok(!r.ok);
    assert.match(r.reason, /Amount mismatch: paid 5\.99, expected 6\.00/);
    assert.equal(r.paidAmount?.toFixed(2), "5.99");
  });

  it("rejects a different currency", () => {
    const r = checkPaidAmount({ ...base, sessionCurrency: "eur" });
    assert.ok(!r.ok);
    assert.match(r.reason, /Currency mismatch/);
  });

  it("rejects when the shipment was re-priced after checkout started", () => {
    const r = checkPaidAmount({ ...base, shipmentPrice: D("7.00") });
    assert.ok(!r.ok);
    assert.match(r.reason, /price changed to 7\.00/);
  });

  it("rejects a missing amount", () => {
    assert.ok(!checkPaidAmount({ ...base, sessionAmountTotal: null }).ok);
  });

  it("compares in integer cents, not floats", () => {
    assert.ok(checkPaidAmount({ ...base, expectedAmount: D("0.29"), shipmentPrice: D("0.29"), sessionAmountTotal: 29 }).ok);
  });
});

describe("webhook helpers", () => {
  it("knows which events it handles", () => {
    assert.ok(isHandledStripeEvent("checkout.session.completed"));
    assert.ok(isHandledStripeEvent("charge.refunded"));
    assert.ok(!isHandledStripeEvent("customer.created"));
  });

  it("reads ids from strings or expanded objects", () => {
    assert.equal(stripeId("pi_1"), "pi_1");
    assert.equal(stripeId({ id: "pi_2" }), "pi_2");
    assert.equal(stripeId(null), null);
  });
});
