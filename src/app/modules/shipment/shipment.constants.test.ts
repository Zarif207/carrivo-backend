import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Role, ShipmentStatus as S } from "../../../generated/prisma/enums.js";
import {
  MAX_DELIVERY_ATTEMPTS,
  STATUS_ENDPOINT_TARGETS,
  TRANSITIONS,
  allowedTransitions,
  canRoleTransition,
  getAllowedNextStatuses,
  isTransitionLegal,
} from "./shipment.constants.js";

describe("shipment state machine", () => {
  it("derives allowedTransitions from TRANSITIONS", () => {
    assert.deepEqual([...allowedTransitions.COURIER_ASSIGNED].sort(), [S.CANCELLED, S.PICKED_UP, S.PICKUP_SCHEDULED].sort());
    assert.deepEqual(allowedTransitions.DELIVERED, []);
  });

  it("applies the agreed role rules", () => {
    assert.ok(canRoleTransition(S.PENDING, S.PICKUP_SCHEDULED, Role.CUSTOMER));
    assert.ok(!canRoleTransition(S.PENDING, S.PICKUP_SCHEDULED, Role.ADMIN));
    assert.ok(canRoleTransition(S.PICKUP_SCHEDULED, S.COURIER_ASSIGNED, Role.ADMIN));
    assert.ok(canRoleTransition(S.COURIER_ASSIGNED, S.PICKED_UP, Role.COURIER));
    assert.ok(!canRoleTransition(S.COURIER_ASSIGNED, S.PICKED_UP, Role.ADMIN));
    for (const [from, to] of [
      [S.PICKED_UP, S.AT_ORIGIN_HUB],
      [S.AT_ORIGIN_HUB, S.IN_TRANSIT],
      [S.IN_TRANSIT, S.AT_DESTINATION_HUB],
      [S.AT_DESTINATION_HUB, S.OUT_FOR_DELIVERY],
    ] as const) {
      assert.ok(canRoleTransition(from, to, Role.ADMIN), `${from}->${to} admin`);
      assert.ok(!canRoleTransition(from, to, Role.COURIER), `${from}->${to} not courier`);
    }
    assert.ok(canRoleTransition(S.OUT_FOR_DELIVERY, S.DELIVERED, Role.COURIER));
    assert.ok(canRoleTransition(S.OUT_FOR_DELIVERY, S.FAILED_DELIVERY, Role.COURIER));
    assert.ok(canRoleTransition(S.FAILED_DELIVERY, S.OUT_FOR_DELIVERY, Role.COURIER));
    assert.ok(canRoleTransition(S.FAILED_DELIVERY, S.RETURNED, Role.ADMIN));
    assert.ok(!canRoleTransition(S.FAILED_DELIVERY, S.RETURNED, Role.COURIER));
  });

  it("allows cancelling only before PICKED_UP", () => {
    for (const from of [S.PENDING, S.PICKUP_SCHEDULED, S.COURIER_ASSIGNED]) assert.ok(isTransitionLegal(from, S.CANCELLED, 0));
    for (const from of [S.PICKED_UP, S.IN_TRANSIT, S.OUT_FOR_DELIVERY, S.DELIVERED]) assert.ok(!isTransitionLegal(from, S.CANCELLED, 0));
  });

  it(`allows only RETURNED after ${MAX_DELIVERY_ATTEMPTS} failed attempts`, () => {
    assert.deepEqual(getAllowedNextStatuses(S.FAILED_DELIVERY, 2).sort(), [S.OUT_FOR_DELIVERY, S.RETURNED].sort());
    assert.deepEqual(getAllowedNextStatuses(S.FAILED_DELIVERY, 3), [S.RETURNED]);
    assert.deepEqual(getAllowedNextStatuses(S.FAILED_DELIVERY, 3, Role.COURIER), []);
    assert.deepEqual(getAllowedNextStatuses(S.FAILED_DELIVERY, 2, Role.COURIER), [S.OUT_FOR_DELIVERY]);
  });

  it("filters allowed next statuses by role", () => {
    assert.deepEqual(getAllowedNextStatuses(S.COURIER_ASSIGNED, 0, Role.COURIER), [S.PICKED_UP]);
    assert.deepEqual(getAllowedNextStatuses(S.PICKED_UP, 0, Role.COURIER), []);
  });

  it("every PATCH /status target is reachable by courier or admin", () => {
    for (const to of STATUS_ENDPOINT_TARGETS) {
      const reachable = Object.values(TRANSITIONS).some((targets) =>
        (targets[to] ?? []).some((role) => role === Role.COURIER || role === Role.ADMIN),
      );
      assert.ok(reachable, to);
    }
  });
});
