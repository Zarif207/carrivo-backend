import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_WEIGHT_LB, normalizeUsAddress, phoneSchema, usAddressSchema, weightSchema } from "./commonValidation.js";

describe("phoneSchema (US)", () => {
  for (const ok of ["(212) 555-0142", "212-555-0142", "212.555.0142", "2125550142", "+1 212 555 0142", "+1 (310) 555-0199", "1-213-555-0100"]) {
    it(`accepts ${ok}`, () => assert.equal(phoneSchema.safeParse(ok).success, true));
  }
  for (const bad of ["+44 20 7946 0958", "555-0142", "012-555-0142", "212-055-0142", "(212) 555-01420", "phone", ""]) {
    it(`rejects ${JSON.stringify(bad)}`, () => assert.equal(phoneSchema.safeParse(bad).success, false));
  }
});

describe("usAddressSchema", () => {
  it("accepts street, city, state, ZIP and ZIP+4", () => {
    assert.equal(usAddressSchema.parse("350 5th Ave, New York, NY 10118"), "350 5th Ave, New York, NY 10118");
    assert.equal(usAddressSchema.parse("200 N Spring St, Los Angeles, CA 90012-3239"), "200 N Spring St, Los Angeles, CA 90012-3239");
    assert.equal(usAddressSchema.parse("47-10 Austell Pl, Long Island City, NY 11101"), "47-10 Austell Pl, Long Island City, NY 11101");
  });

  it("upper-cases the state code and tidies spaces", () => {
    assert.equal(usAddressSchema.parse("  1 Main St ,  Jersey City , nj 07302 "), "1 Main St, Jersey City, NJ 07302");
  });

  it("allows an apartment or suite in the street part", () => {
    assert.equal(normalizeUsAddress("12 Elm St, Apt 4B, Brooklyn, NY 11201"), "12 Elm St, Apt 4B, Brooklyn, NY 11201");
  });

  for (const bad of [
    "10 Downing St, London SW1A 2AA", // not US
    "350 5th Ave, New York, XX 10118", // not a state
    "350 5th Ave, New York, NY 1011", // short ZIP
    "350 5th Ave New York NY 10118", // no commas
    "New York, NY 10118", // no street
    "350 5th Ave, New York, NY", // no ZIP
  ]) {
    it(`rejects ${JSON.stringify(bad)}`, () => assert.equal(usAddressSchema.safeParse(bad).success, false));
  }
});

describe("weightSchema (lb)", () => {
  it("accepts up to the cap, rounded to 2 decimals", () => {
    assert.equal(weightSchema.parse(4.456), 4.46);
    assert.equal(weightSchema.parse(MAX_WEIGHT_LB), MAX_WEIGHT_LB);
  });
  it("rejects zero, negatives and over-cap weights", () => {
    for (const bad of [0, -1, MAX_WEIGHT_LB + 0.01, 0.001]) assert.equal(weightSchema.safeParse(bad).success, false, String(bad));
  });
});
