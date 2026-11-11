/**
 * Demo courier drivers per zone: the roster and the pure planning (no database, no I/O), so
 * seed-couriers.test.ts can check it without a database. prisma/seed-couriers.ts reads the target
 * database's zones and hubs, asks planCourierSeed what to create, and creates only that.
 *
 * Fictional people only (no real people or celebrities). Phones use the reserved fictional
 * 555-0100 to 555-0199 range in +1 format. Plates are clearly dummy ("DEMO-NYC-01"). No licence
 * or ID numbers are ever generated.
 */
import { VehicleType } from "../src/generated/prisma/enums.js";

export interface RosterZone {
  /** Matched against the database zone name (see zoneKey), never against ids. */
  name: string;
  /** Area code for the phones of this zone's couriers. */
  areaCode: string;
  /** Dense city: bicycles allowed. */
  dense: boolean;
  /** Biggest metros get three couriers, the rest two (see couriersFor). */
  big: boolean;
  /** Fictional drivers, in order; only the first couriersFor(zone) are used. */
  drivers: readonly (readonly [first: string, last: string])[];
}

export const ROSTER: readonly RosterZone[] = [
  { name: "New York Metro", areaCode: "212", dense: true, big: true, drivers: [["Aaliyah", "Brooks"], ["Daniel", "Okafor"], ["Mei", "Chen"]] },
  { name: "Los Angeles Metro", areaCode: "213", dense: false, big: true, drivers: [["Carlos", "Mendoza"], ["Hannah", "Nguyen"], ["Jamal", "Whitaker"]] },
  { name: "Chicago Metro", areaCode: "312", dense: true, big: true, drivers: [["Natalia", "Kowalski"], ["Terrence", "Hale"], ["Priya", "Raman"]] },
  { name: "Houston Metro", areaCode: "713", dense: false, big: true, drivers: [["Diego", "Salinas"], ["Brianna", "Foster"], ["Kwame", "Mensah"]] },
  { name: "Dallas–Fort Worth", areaCode: "214", dense: false, big: true, drivers: [["Luis", "Herrera"], ["Megan", "Doyle"], ["Andre", "Colby"]] },
  { name: "Miami Metro", areaCode: "305", dense: false, big: true, drivers: [["Isabel", "Castillo"], ["Jordan", "Pryce"], ["Tomas", "Alvarez"]] },
  { name: "San Francisco Bay Area", areaCode: "415", dense: true, big: false, drivers: [["Kenji", "Watanabe"], ["Rosa", "Delgado"]] },
  { name: "Seattle Metro", areaCode: "206", dense: false, big: false, drivers: [["Ingrid", "Halvorsen"], ["Malik", "Turner"]] },
  { name: "Atlanta Metro", areaCode: "404", dense: false, big: false, drivers: [["Destiny", "Harrell"], ["Caleb", "Morgan"]] },
  { name: "Phoenix Metro", areaCode: "602", dense: false, big: false, drivers: [["Ana", "Lucero"], ["Wyatt", "Benally"]] },
  { name: "Philadelphia Metro", areaCode: "215", dense: true, big: false, drivers: [["Colleen", "Murtagh"], ["Rashid", "Ahmed"]] },
  { name: "Washington DC Metro", areaCode: "202", dense: true, big: false, drivers: [["Grace", "Abebe"], ["Nathan", "Reyes"]] },
  { name: "Detroit Metro", areaCode: "313", dense: false, big: false, drivers: [["Leila", "Haddad"], ["Darnell", "Pryor"]] },
  { name: "Grand Rapids Metro", areaCode: "616", dense: false, big: false, drivers: [["Lauren", "DeVries"], ["Marco", "Esposito"]] },
  { name: "Ann Arbor Metro", areaCode: "734", dense: false, big: false, drivers: [["Samir", "Patel"], ["Olivia", "Brennan"]] },
  { name: "Lansing Metro", areaCode: "517", dense: false, big: false, drivers: [["Hector", "Ramos"], ["Chloe", "Sutton"]] },
  { name: "Flint Metro", areaCode: "810", dense: false, big: false, drivers: [["Tasha", "Reedy"], ["Brandon", "Kowal"]] },
];

export const couriersFor = (zone: Pick<RosterZone, "big">): number => (zone.big ? 3 : 2);

/** Vehicle rotation per courier slot. Bicycles only where the city is dense. */
const DENSE_VEHICLES = [VehicleType.BICYCLE, VehicleType.MOTORCYCLE, VehicleType.VAN] as const;
const SPREAD_VEHICLES = [VehicleType.CAR, VehicleType.VAN, VehicleType.TRUCK, VehicleType.MOTORCYCLE] as const;

/** "Dallas–Fort Worth", "dallas-fort worth" and "Dallas Fort Worth Metro" are the same zone. */
export const zoneKey = (name: string): string =>
  name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\bmetro\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const slug = (value: string): string =>
  value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

export const courierEmail = (first: string, last: string, zoneCode: string): string => `${slug(first)}.${slug(last)}.${slug(zoneCode)}@carrivo.dev`;

/** The reserved fictional range 555-0100..0199; `serial` 0-99 picks the number. */
export const courierPhone = (areaCode: string, serial: number): string => {
  if (!Number.isInteger(serial) || serial < 0 || serial > 99) throw new Error(`Phone serial out of the 555-01XX range: ${serial}`);
  return `+1 ${areaCode}-555-01${String(serial).padStart(2, "0")}`;
};

/** Clearly not a real plate. Bicycles have none. */
export const dummyPlate = (zoneCode: string, slot: number, vehicle: VehicleType): string | null =>
  vehicle === VehicleType.BICYCLE ? null : `DEMO-${zoneCode.toUpperCase()}-${String(slot + 1).padStart(2, "0")}`;

/** What the target database has (read by the script; ids only travel through). */
export interface DbHub {
  id: string;
  code: string;
}
export interface DbZone {
  id: string;
  code: string;
  name: string;
  /** Active hubs of the zone, in a stable order (by code). */
  hubs: readonly DbHub[];
}

export interface PlannedCourier {
  name: string;
  email: string;
  phone: string;
  zoneId: string;
  zoneCode: string;
  zoneName: string;
  hubId: string | null;
  hubCode: string | null;
  vehicleType: VehicleType;
  vehicleNumber: string | null;
}

export interface CourierSeedPlan {
  /** Couriers whose email does not exist yet: the only ones the script creates. */
  create: PlannedCourier[];
  /** Planned couriers whose email already exists: left exactly as they are. */
  existing: PlannedCourier[];
  /** Roster zones that the database doesn't have (or has inactive): nothing created. */
  skippedZones: string[];
  /** Database zones without a roster entry: nothing created (add drivers to ROSTER to cover them). */
  unrosteredZones: string[];
  /** Per matched zone: how many couriers the roster plans there. */
  perZone: { zone: string; code: string; planned: number; create: number; hubs: number }[];
}

/**
 * Plans every roster courier for the zones the database has. Deterministic: the same zones give
 * the same people, emails, phones, hubs and vehicles every run. Phone serials follow the roster
 * order across all zones (so they stay unique even if two zones share an area code).
 */
export function planCourierSeed(zones: readonly DbZone[], existingEmails: ReadonlySet<string>): CourierSeedPlan {
  const byKey = new Map(zones.map((zone) => [zoneKey(zone.name), zone]));
  const rosterKeys = new Set(ROSTER.map((zone) => zoneKey(zone.name)));
  const plan: CourierSeedPlan = { create: [], existing: [], skippedZones: [], unrosteredZones: [], perZone: [] };
  const existing = new Set([...existingEmails].map((email) => email.toLowerCase()));

  let serial = 0;
  for (const roster of ROSTER) {
    const count = couriersFor(roster);
    const zone = byKey.get(zoneKey(roster.name));
    if (!zone) {
      plan.skippedZones.push(roster.name);
      serial += count; // a zone missing here never shifts another zone's phone numbers
      continue;
    }
    const vehicles = roster.dense ? DENSE_VEHICLES : SPREAD_VEHICLES;
    let created = 0;
    for (let slot = 0; slot < count; slot += 1, serial += 1) {
      const [first, last] = roster.drivers[slot] ?? [];
      if (!first || !last) throw new Error(`ROSTER: ${roster.name} needs ${count} drivers`);
      // Round-robin over the zone's hubs; a zone without hubs gets zone-only couriers.
      const hub = zone.hubs.length > 0 ? zone.hubs[slot % zone.hubs.length] : undefined;
      const vehicleType = vehicles[slot % vehicles.length] ?? VehicleType.CAR;
      const courier: PlannedCourier = {
        name: `${first} ${last}`,
        email: courierEmail(first, last, zone.code),
        phone: courierPhone(roster.areaCode, serial),
        zoneId: zone.id,
        zoneCode: zone.code,
        zoneName: zone.name,
        hubId: hub?.id ?? null,
        hubCode: hub?.code ?? null,
        vehicleType,
        vehicleNumber: dummyPlate(zone.code, slot, vehicleType),
      };
      if (existing.has(courier.email)) plan.existing.push(courier);
      else {
        plan.create.push(courier);
        created += 1;
      }
    }
    plan.perZone.push({ zone: zone.name, code: zone.code, planned: count, create: created, hubs: zone.hubs.length });
  }
  plan.unrosteredZones = zones.filter((zone) => !rosterKeys.has(zoneKey(zone.name))).map((zone) => zone.name);
  return plan;
}
