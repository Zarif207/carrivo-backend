import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma } from "../../../generated/prisma/client.js";
import { calculateCourierEarning } from "./courier.utils.js";

describe("calculateCourierEarning (20% of price)", () => {
  it("takes 20% of the price", () => {
    assert.equal(calculateCourierEarning(new Prisma.Decimal("160.00")), "32.00");
    assert.equal(calculateCourierEarning("105.00"), "21.00");
    assert.equal(calculateCourierEarning(0), "0.00");
  });

  it("rounds half up to 2 decimals", () => {
    assert.equal(calculateCourierEarning("100.03"), "20.01"); // 20.006
    assert.equal(calculateCourierEarning("100.02"), "20.00"); // 20.004
    assert.equal(calculateCourierEarning("0.025"), "0.01"); // 0.005
  });

  it("uses decimal math", () => {
    assert.equal(calculateCourierEarning("0.15"), "0.03");
    assert.equal(calculateCourierEarning("99999999.99"), "20000000.00");
  });
});
