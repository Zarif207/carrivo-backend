/**
 * The demo delivery network: zones, hubs and pricing rules (pure data, no database access, so
 * seed.network.test.ts can check it without running the seed).
 *
 * US demo data. Phone numbers use the fictional 555-0100 to 555-0199 range; street addresses are
 * generic locations in real logistics districts (no real businesses or residents). Addresses follow
 * "street, City, ST ZIP" (validated by usAddressSchema in the API).
 *
 * Pricing is three distance tiers, built only from the existing rule model (service + ordered zone
 * pair, with the service's default rule as the fallback), so the quote logic is unchanged:
 * - Metro:    origin = destination zone (one rule per zone and service, Same Day included).
 * - Regional: two different metros less than ~750 miles apart (straight line), both directions.
 * - National: everything else, priced by the service's default rule (both zones null).
 * Same Day has no default rule, so it is offered only within one zone (other routes answer 422).
 */
import { ServiceType } from "../src/generated/prisma/enums.js";

export interface SeedHub {
  code: string;
  name: string;
  address: string;
  city: string;
  phone: string;
}

export interface SeedZone {
  code: string;
  name: string;
  description: string;
  /** The first hub is the zone's main hub (code HUB-<zone code>); shipments route through it. */
  hubs: [SeedHub, ...SeedHub[]];
}

/** Existing zones first: their codes, names and hubs must never change (sample shipments use them). */
export const ZONES: SeedZone[] = [
  {
    code: "NYC",
    name: "New York Metro",
    description: "Manhattan, Brooklyn, Queens and Jersey City",
    hubs: [
      { code: "HUB-NYC", name: "Queens Hub", address: "47-10 Austell Pl, Long Island City, NY 11101", city: "Long Island City", phone: "(212) 555-0100" },
      { code: "HUB-NYC-JC", name: "Jersey City Hub", address: "180 Harbor Dr, Jersey City, NJ 07305", city: "Jersey City", phone: "(201) 555-0101" },
    ],
  },
  {
    code: "LA",
    name: "Los Angeles Metro",
    description: "Downtown LA, Santa Monica, Pasadena and Long Beach",
    hubs: [
      { code: "HUB-LA", name: "Downtown LA Hub", address: "1200 E 7th St, Los Angeles, CA 90021", city: "Los Angeles", phone: "(213) 555-0102" },
      { code: "HUB-LA-LB", name: "Long Beach Hub", address: "2400 E Pacific Coast Hwy, Long Beach, CA 90804", city: "Long Beach", phone: "(562) 555-0103" },
    ],
  },
  {
    code: "CHI",
    name: "Chicago Metro",
    description: "Downtown, Oak Park, Evanston and Cicero",
    hubs: [
      { code: "HUB-CHI", name: "Clearing Hub", address: "6500 W 65th St, Chicago, IL 60638", city: "Chicago", phone: "(312) 555-0160" },
      { code: "HUB-CHI-GI", name: "Goose Island Hub", address: "1300 N Elston Ave, Chicago, IL 60642", city: "Chicago", phone: "(773) 555-0161" },
    ],
  },
  {
    code: "HOU",
    name: "Houston Metro",
    description: "Downtown, the Heights, Pasadena and Sugar Land",
    hubs: [
      { code: "HUB-HOU", name: "East End Hub", address: "2600 Navigation Blvd, Houston, TX 77003", city: "Houston", phone: "(713) 555-0162" },
      { code: "HUB-HOU-NW", name: "Northwest Houston Hub", address: "10500 Kempwood Dr, Houston, TX 77043", city: "Houston", phone: "(832) 555-0163" },
    ],
  },
  {
    code: "MIA",
    name: "Miami Metro",
    description: "Downtown Miami, Miami Beach, Coral Gables and Hialeah",
    hubs: [
      { code: "HUB-MIA", name: "Airport West Hub", address: "7500 NW 25th St, Miami, FL 33122", city: "Miami", phone: "(305) 555-0164" },
      { code: "HUB-MIA-AL", name: "Allapattah Hub", address: "2100 NW 20th St, Miami, FL 33142", city: "Miami", phone: "(786) 555-0165" },
    ],
  },
  {
    code: "SF",
    name: "San Francisco Bay Area",
    description: "San Francisco, Oakland, Berkeley and Daly City",
    hubs: [
      { code: "HUB-SF", name: "Bayview Hub", address: "1500 Evans Ave, San Francisco, CA 94124", city: "San Francisco", phone: "(415) 555-0166" },
      { code: "HUB-SF-OAK", name: "West Oakland Hub", address: "2500 Peralta St, Oakland, CA 94607", city: "Oakland", phone: "(510) 555-0167" },
    ],
  },
  {
    code: "SEA",
    name: "Seattle Metro",
    description: "Downtown Seattle, Bellevue, Tacoma and Everett",
    hubs: [
      { code: "HUB-SEA", name: "SoDo Hub", address: "3400 1st Ave S, Seattle, WA 98134", city: "Seattle", phone: "(206) 555-0168" },
      { code: "HUB-SEA-GT", name: "Georgetown Hub", address: "5900 4th Ave S, Seattle, WA 98108", city: "Seattle", phone: "(206) 555-0169" },
    ],
  },
  {
    code: "ATL",
    name: "Atlanta Metro",
    description: "Midtown, Buckhead, Decatur and Marietta",
    hubs: [
      { code: "HUB-ATL", name: "Westside Hub", address: "1100 Huff Rd NW, Atlanta, GA 30318", city: "Atlanta", phone: "(404) 555-0170" },
      { code: "HUB-ATL-AP", name: "Airport South Hub", address: "3500 Southside Industrial Pkwy, Atlanta, GA 30354", city: "Atlanta", phone: "(470) 555-0171" },
    ],
  },
];

// ───────────── Pricing (USD, pounds) ─────────────

export interface SeedRule {
  name: string;
  serviceType: ServiceType;
  route: [string, string] | null; // [originZoneCode, destinationZoneCode]; null = default rule
  baseFee: number;
  baseWeightLb: number;
  perLbFee: number;
  maxWeightLb: number | null;
}

type Rates = Pick<SeedRule, "baseFee" | "perLbFee" | "maxWeightLb">;

/** Every rule covers the first 2 lb in the base fee. Weight limits per service never change by distance. */
const BASE_WEIGHT_LB = 2;
const MAX_WEIGHT_LB: Record<ServiceType, number> = { STANDARD: 70, EXPRESS: 50, SAME_DAY: 20 };

export const TIER_RATES = {
  metro: {
    STANDARD: { baseFee: 6.5, perLbFee: 0.6 },
    EXPRESS: { baseFee: 11.0, perLbFee: 1.0 },
    SAME_DAY: { baseFee: 18.0, perLbFee: 1.5 },
  },
  regional: {
    STANDARD: { baseFee: 9.0, perLbFee: 0.9 },
    EXPRESS: { baseFee: 17.0, perLbFee: 1.75 },
  },
  national: {
    STANDARD: { baseFee: 12.0, perLbFee: 1.25 },
    EXPRESS: { baseFee: 24.0, perLbFee: 2.5 },
  },
} as const;

/**
 * Metro pairs under ~750 straight-line miles, priced at the regional tier in both directions.
 * Approximate distances: LA–SF 350, SF–SEA 680, NYC–CHI 710, NYC–ATL 750, CHI–ATL 590, ATL–MIA 600, ATL–HOU 690.
 * Every other pair between two different zones is national (the default rule).
 */
export const REGIONAL_PAIRS: readonly [string, string][] = [
  ["LA", "SF"],
  ["SF", "SEA"],
  ["NYC", "CHI"],
  ["NYC", "ATL"],
  ["CHI", "ATL"],
  ["ATL", "MIA"],
  ["ATL", "HOU"],
];

const SERVICE_LABEL: Record<ServiceType, string> = { STANDARD: "Standard", EXPRESS: "Express", SAME_DAY: "Same Day" };

const rule = (serviceType: ServiceType, name: string, route: [string, string] | null, rates: { baseFee: number; perLbFee: number }): SeedRule => ({
  name,
  serviceType,
  route,
  baseFee: rates.baseFee,
  baseWeightLb: BASE_WEIGHT_LB,
  perLbFee: rates.perLbFee,
  maxWeightLb: MAX_WEIGHT_LB[serviceType],
});

const zoneName = (code: string): string => {
  const zone = ZONES.find((z) => z.code === code);
  if (!zone) throw new Error(`Seed network: unknown zone code ${code}`);
  return zone.name;
};

const buildPricingRules = (): SeedRule[] => {
  const rules: SeedRule[] = [];
  const crossCountry: ServiceType[] = [ServiceType.STANDARD, ServiceType.EXPRESS];
  // National: the default rules. The names are the seed's match key, so they keep their original
  // wording ("Cross-country") and existing rows are updated in place, never duplicated.
  for (const service of crossCountry) {
    rules.push(rule(service, `${SERVICE_LABEL[service]} - Cross-country`, null, TIER_RATES.national[service as keyof typeof TIER_RATES.national]));
  }
  // Metro: within each zone (names match the original NYC and LA rules).
  for (const service of [ServiceType.STANDARD, ServiceType.EXPRESS, ServiceType.SAME_DAY]) {
    for (const zone of ZONES) {
      rules.push(rule(service, `${SERVICE_LABEL[service]} - Within ${zone.name}`, [zone.code, zone.code], TIER_RATES.metro[service]));
    }
  }
  // Regional: both directions of each nearby pair.
  for (const service of crossCountry) {
    for (const [a, b] of REGIONAL_PAIRS) {
      for (const [from, to] of [
        [a, b],
        [b, a],
      ] as const) {
        rules.push(rule(service, `${SERVICE_LABEL[service]} - ${zoneName(from)} to ${zoneName(to)}`, [from, to], TIER_RATES.regional[service as keyof typeof TIER_RATES.regional]));
      }
    }
  }
  return rules;
};

export const PRICING_RULES: SeedRule[] = buildPricingRules();
