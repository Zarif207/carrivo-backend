import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ServiceType } from "../src/generated/prisma/enums.js";
import { calculatePrice } from "../src/app/modules/pricing/pricing.utils.js";
import { phoneSchema, usAddressSchema } from "../src/app/utils/commonValidation.js";
import { PRICING_RULES, REGIONAL_PAIRS, ZONES, type SeedRule } from "./seed.network.js";

const HUBS = ZONES.flatMap((zone) => zone.hubs.map((hub) => ({ ...hub, zoneCode: zone.code })));
const CODES = ZONES.map((zone) => zone.code);

/** The API's lookup (pricing.service.ts findApplicableRule): exact route rule, else the default rule. */
const findRule = (service: ServiceType, from: string, to: string): SeedRule | undefined =>
  PRICING_RULES.find((r) => r.serviceType === service && r.route?.[0] === from && r.route?.[1] === to) ??
  PRICING_RULES.find((r) => r.serviceType === service && r.route === null);

const quote = (service: ServiceType, from: string, to: string, weightLb = 5): number => {
  const rule = findRule(service, from, to);
  assert.ok(rule, `no rule for ${service} ${from} → ${to}`);
  const result = calculatePrice(rule, weightLb);
  assert.ok(result.ok, `${service} ${from} → ${to} at ${weightLb} lb is not quotable`);
  return Number(result.breakdown.total);
};

/** First ZIP digits per state (USPS prefixes), to catch a ZIP paired with the wrong state. */
const ZIP_PREFIXES: Record<string, RegExp> = {
  NY: /^1[0-4]/,
  NJ: /^0[78]/,
  CA: /^9[0-6]/,
  IL: /^6[0-2]/,
  TX: /^(7[5-9]|88)/,
  FL: /^3[2-4]/,
  WA: /^9[89]/,
  GA: /^3[01]/,
};

describe("seed network: zones and hubs", () => {
  it("has 8 zones with 2 hubs each (16 hubs), unique codes", () => {
    assert.equal(ZONES.length, 8);
    assert.equal(HUBS.length, 16);
    assert.ok(ZONES.every((zone) => zone.hubs.length === 2));
    assert.equal(new Set(CODES).size, 8);
    assert.equal(new Set(HUBS.map((hub) => hub.code)).size, 16);
  });

  it("keeps the original zones and hubs exactly (ids are upserted by code)", () => {
    const pick = (code: string) => ZONES.find((zone) => zone.code === code);
    assert.equal(pick("NYC")?.name, "New York Metro");
    assert.equal(pick("LA")?.name, "Los Angeles Metro");
    assert.deepEqual(pick("NYC")?.hubs.map((h) => [h.code, h.name]), [["HUB-NYC", "Queens Hub"], ["HUB-NYC-JC", "Jersey City Hub"]]);
    assert.deepEqual(pick("LA")?.hubs.map((h) => [h.code, h.name]), [["HUB-LA", "Downtown LA Hub"], ["HUB-LA-LB", "Long Beach Hub"]]);
  });

  it("adds the six new metros", () => {
    assert.deepEqual(
      ZONES.slice(2).map((zone) => zone.name),
      ["Chicago Metro", "Houston Metro", "Miami Metro", "San Francisco Bay Area", "Seattle Metro", "Atlanta Metro"],
    );
  });

  it("names each zone's main hub HUB-<zone code> (sample shipments route through it)", () => {
    for (const zone of ZONES) assert.equal(zone.hubs[0].code, `HUB-${zone.code}`);
  });

  it("gives every zone a short coverage description", () => {
    for (const zone of ZONES) assert.match(zone.description, /^[A-Z][\w .,'-]+ and [\w .'-]+$/, zone.code);
  });

  it("uses valid US addresses whose city matches and whose ZIP fits the state", () => {
    for (const hub of HUBS) {
      assert.equal(usAddressSchema.parse(hub.address), hub.address, hub.code);
      const match = /, ([^,]+), ([A-Z]{2}) (\d{5})$/.exec(hub.address);
      assert.ok(match, hub.code);
      const [, city, state, zip] = match;
      assert.equal(city, hub.city, `${hub.code} city`);
      assert.match(zip ?? "", ZIP_PREFIXES[state ?? ""] ?? /^$/, `${hub.code} ZIP ${zip} for ${state}`);
    }
  });

  it("uses valid, unique 555-01xx phone numbers", () => {
    for (const hub of HUBS) {
      assert.equal(phoneSchema.parse(hub.phone), hub.phone, hub.code);
      assert.match(hub.phone, /555-01\d\d$/, hub.code);
    }
    assert.equal(new Set(HUBS.map((hub) => hub.phone)).size, HUBS.length);
  });
});

describe("seed network: pricing", () => {
  it("has 54 uniquely named rules (23 Standard, 23 Express, 8 Same Day)", () => {
    assert.equal(PRICING_RULES.length, 54);
    assert.equal(new Set(PRICING_RULES.map((r) => r.name)).size, 54);
    const count = (service: ServiceType) => PRICING_RULES.filter((r) => r.serviceType === service).length;
    assert.deepEqual([count(ServiceType.STANDARD), count(ServiceType.EXPRESS), count(ServiceType.SAME_DAY)], [23, 23, 8]);
  });

  it("keeps the original eight rules unchanged (matched by name)", () => {
    const byName = new Map(PRICING_RULES.map((r) => [r.name, r]));
    const original: [string, ServiceType, [string, string] | null, number, number, number][] = [
      ["Standard - Cross-country", ServiceType.STANDARD, null, 12, 1.25, 70],
      ["Standard - Within New York Metro", ServiceType.STANDARD, ["NYC", "NYC"], 6.5, 0.6, 70],
      ["Standard - Within Los Angeles Metro", ServiceType.STANDARD, ["LA", "LA"], 6.5, 0.6, 70],
      ["Express - Cross-country", ServiceType.EXPRESS, null, 24, 2.5, 50],
      ["Express - Within New York Metro", ServiceType.EXPRESS, ["NYC", "NYC"], 11, 1, 50],
      ["Express - Within Los Angeles Metro", ServiceType.EXPRESS, ["LA", "LA"], 11, 1, 50],
      ["Same Day - Within New York Metro", ServiceType.SAME_DAY, ["NYC", "NYC"], 18, 1.5, 20],
      ["Same Day - Within Los Angeles Metro", ServiceType.SAME_DAY, ["LA", "LA"], 18, 1.5, 20],
    ];
    for (const [name, serviceType, route, baseFee, perLbFee, maxWeightLb] of original) {
      assert.deepEqual(byName.get(name), { name, serviceType, route, baseFee, baseWeightLb: 2, perLbFee, maxWeightLb }, name);
    }
  });

  it("makes every ordered zone pair quotable for Standard and Express", () => {
    for (const service of [ServiceType.STANDARD, ServiceType.EXPRESS]) {
      for (const from of CODES) for (const to of CODES) assert.ok(quote(service, from, to) > 0);
    }
  });

  it("offers Same Day within a zone only (other routes have no rule → 422)", () => {
    for (const from of CODES) {
      for (const to of CODES) {
        const rule = findRule(ServiceType.SAME_DAY, from, to);
        if (from === to) assert.ok(rule, `Same Day within ${from}`);
        else assert.equal(rule, undefined, `Same Day ${from} → ${to}`);
      }
    }
  });

  it("prices by distance: metro < regional < national, in both directions", () => {
    const regional = new Set(REGIONAL_PAIRS.flatMap(([a, b]) => [`${a}>${b}`, `${b}>${a}`]));
    for (const service of [ServiceType.STANDARD, ServiceType.EXPRESS]) {
      const metro = quote(service, "CHI", "CHI");
      const region = quote(service, "CHI", "ATL");
      const national = quote(service, "SEA", "MIA");
      assert.ok(metro < region && region < national, `${service}: ${metro} < ${region} < ${national}`);
      for (const from of CODES) {
        for (const to of CODES) {
          const expected = from === to ? metro : regional.has(`${from}>${to}`) ? region : national;
          assert.equal(quote(service, from, to), expected, `${service} ${from} → ${to}`);
          assert.equal(quote(service, from, to), quote(service, to, from), `${service} ${from} ↔ ${to} symmetric`);
        }
      }
    }
  });

  it("keeps one weight limit per service and the 2 lb base everywhere", () => {
    for (const r of PRICING_RULES) assert.equal(r.baseWeightLb, 2, r.name);
    const limit = (service: ServiceType) => new Set(PRICING_RULES.filter((r) => r.serviceType === service).map((r) => r.maxWeightLb));
    assert.deepEqual([...limit(ServiceType.STANDARD)], [70]);
    assert.deepEqual([...limit(ServiceType.EXPRESS)], [50]);
    assert.deepEqual([...limit(ServiceType.SAME_DAY)], [20]);
  });

  it("only references known zones", () => {
    for (const r of PRICING_RULES) for (const code of r.route ?? []) assert.ok(CODES.includes(code), `${r.name}: ${code}`);
  });
});
