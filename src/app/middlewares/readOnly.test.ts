import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it, mock } from "node:test";
import type { Router } from "express";
import { Role } from "../../generated/prisma/enums.js";

// No external services in unit tests: without Upstash settings the rate limiter and cache fall
// back to memory. Set before the app (and env.ts, which won't override set variables) loads.
process.env["UPSTASH_REDIS_REST_URL"] = "";
process.env["UPSTASH_REDIS_REST_TOKEN"] = "";

const { default: app } = await import("../../app.js");
const { STAFF_ROLES } = await import("../config/roles.js");
const { auth } = await import("../lib/auth.js");
const { AuthRoutes } = await import("../modules/auth/auth.route.js");
const { moduleRoutes } = await import("../routes/index.js");
const { authenticate } = await import("./authenticate.js");
const { READ_ONLY_MESSAGE, violatesReadOnly } = await import("./readOnly.js");

/*
 * The read-only rule is tested against the REAL route table: every route the app exposes is
 * listed by walking the routers, so a route added later is covered without editing this file.
 * Sessions are mocked (no database needed): requests that should be refused never reach a
 * controller, because authenticate() / authorize() reject them first.
 */

const API = "/api/v1";
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SAMPLE_ID = "01a1b453-0000-7000-8000-000000000000";

interface Layer {
  route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] };
  handle: unknown;
  name: string;
}

interface RouteInfo {
  method: string;
  path: string;
  authenticated: boolean;
  /** Roles allowed by authorize() (router-level and route-level); null = no authorize. */
  roles: readonly Role[] | null;
}

const rolesOf = (fn: unknown): readonly Role[] | null =>
  typeof fn === "function" && "allowedRoles" in fn ? (fn as { allowedRoles: readonly Role[] }).allowedRoles : null;

/** Lists a flat module router: its route layers plus router-level authenticate/authorize. */
function walk(mount: string, router: Router): RouteInfo[] {
  const stack = (router as unknown as { stack: Layer[] }).stack;
  const routes: RouteInfo[] = [];
  let routerAuth = false;
  let routerRoles: readonly Role[] | null = null;
  for (const layer of stack) {
    if (!layer.route) {
      // Nested routers would hide their paths from this walk: keep module routers flat.
      assert.notEqual(layer.name, "router", `${mount} mounts a nested router; register its routes directly`);
      if (layer.handle === authenticate) routerAuth = true;
      routerRoles = rolesOf(layer.handle) ?? routerRoles;
      continue;
    }
    const handles = layer.route.stack.map((l) => l.handle);
    const routeRoles = handles.map(rolesOf).filter((r): r is readonly Role[] => r !== null);
    // Every authorize() in the chain must pass, so the effective set is their intersection.
    const all = [routerRoles, ...routeRoles].filter((r): r is readonly Role[] => r !== null);
    const roles = all.length ? all.reduce((acc, r) => acc.filter((x) => r.includes(x))) : null;
    for (const [method, on] of Object.entries(layer.route.methods)) {
      if (!on || method === "_all") continue;
      routes.push({
        method: method.toUpperCase(),
        path: `${mount}${layer.route.path === "/" ? "" : layer.route.path}`,
        authenticated: routerAuth || handles.includes(authenticate),
        roles,
      });
    }
  }
  return routes;
}

const ROUTES: RouteInfo[] = [...moduleRoutes.flatMap(({ path, route }) => walk(`${API}${path}`, route)), ...walk(`${API}/auth`, AuthRoutes)];

const concrete = (path: string) => path.replace(/:[A-Za-z]+/g, SAMPLE_ID);

/** Mutating routes that are deliberately public (no session): reviewed list, so new ones fail this test. */
const PUBLIC_MUTATIONS = new Set([
  `POST ${API}/auth/register`,
  `POST ${API}/auth/login`,
  `POST ${API}/auth/change-password`, // only the auth rate limiter; Better Auth handles it (guarded by blockReadOnlyOnBetterAuth)
  `POST ${API}/auth/google/exchange`,
  `POST ${API}/pricing/estimate`,
]);

/** Admin GET routes the viewer must NOT get, with the reason. */
const VIEWER_GET_EXCLUSIONS = new Set([`GET ${API}/payments/verify`]); // verify can write (reconciles a paid session)

describe("violatesReadOnly", () => {
  it("lets every role read and non-viewers write", () => {
    for (const role of Object.values(Role)) {
      assert.equal(violatesReadOnly(role, "GET", `${API}/admin/users`), false);
      assert.equal(violatesReadOnly(role, "HEAD", `${API}/zones`), false);
    }
    for (const role of [Role.ADMIN, Role.COURIER, Role.CUSTOMER]) {
      assert.equal(violatesReadOnly(role, "POST", `${API}/zones`), false);
    }
  });

  it("blocks every write for ADMIN_VIEWER except logout and token refresh", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"]) {
      assert.equal(violatesReadOnly(Role.ADMIN_VIEWER, method, `${API}/zones/${SAMPLE_ID}`), true);
    }
    assert.equal(violatesReadOnly(Role.ADMIN_VIEWER, "POST", `${API}/auth/logout`), false);
    assert.equal(violatesReadOnly(Role.ADMIN_VIEWER, "POST", `${API}/auth/refresh-token?x=1`), false);
    assert.equal(violatesReadOnly(Role.ADMIN_VIEWER, "POST", `${API}/auth/logout/`), false);
    assert.equal(violatesReadOnly(Role.ADMIN_VIEWER, "PATCH", `${API}/auth/logout`), true);
    assert.equal(violatesReadOnly(Role.ADMIN_VIEWER, "POST", `${API}/auth/change-password`), true);
  });
});

describe("route table", () => {
  it("found the routes (walk sanity check)", () => {
    assert.ok(ROUTES.length > 40, `only ${ROUTES.length} routes found`);
    assert.ok(ROUTES.some((r) => r.method === "GET" && r.path === `${API}/admin/audit-logs`));
  });

  it("every mutating route is authenticated or on the reviewed public list", () => {
    const unreviewed = ROUTES.filter((r) => MUTATING.has(r.method) && !r.authenticated && !PUBLIC_MUTATIONS.has(`${r.method} ${r.path}`));
    assert.deepEqual(unreviewed.map((r) => `${r.method} ${r.path}`), []);
  });

  it("ADMIN_VIEWER is allowed on every GET route that ADMIN can use", () => {
    const missing = ROUTES.filter(
      (r) => r.method === "GET" && r.roles?.includes(Role.ADMIN) && !r.roles.includes(Role.ADMIN_VIEWER) && !VIEWER_GET_EXCLUSIONS.has(`GET ${r.path}`),
    );
    assert.deepEqual(missing.map((r) => r.path), []);
  });

  it("ADMIN_VIEWER is not allowed on customer- or courier-only routes", () => {
    const leaks = ROUTES.filter((r) => r.roles && !r.roles.includes(Role.ADMIN) && r.roles.includes(Role.ADMIN_VIEWER));
    assert.deepEqual(leaks.map((r) => `${r.method} ${r.path}`), []);
  });

  it("no mutating route lists ADMIN_VIEWER without ADMIN-level checks (read-only rule backs it up)", () => {
    for (const r of ROUTES.filter((x) => MUTATING.has(x.method) && x.authenticated)) {
      const allowed = `${r.method} ${r.path}` === `POST ${API}/auth/logout` || `${r.method} ${r.path}` === `POST ${API}/auth/refresh-token`;
      assert.equal(violatesReadOnly(Role.ADMIN_VIEWER, r.method, concrete(r.path)), !allowed, `${r.method} ${r.path}`);
    }
  });

  it("STAFF_ROLES is exactly ADMIN + ADMIN_VIEWER", () => {
    assert.deepEqual([...STAFF_ROLES].sort(), [Role.ADMIN, Role.ADMIN_VIEWER].sort());
  });
});

describe("HTTP: a viewer session", () => {
  let base = "";
  let server: ReturnType<typeof app.listen>;

  const viewerSession = (role: Role) => ({
    user: { id: "viewer-id", email: "viewer@carrivo.dev", name: "Carrivo Viewer", role, status: "ACTIVE", deletedAt: null },
    session: { id: "s1", token: "t1", expiresAt: new Date(Date.now() + 3_600_000) },
  });

  before(async () => {
    mock.method(auth.api, "getSession", async () => viewerSession(Role.ADMIN_VIEWER));
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.close();
    mock.restoreAll();
  });

  const call = async (method: string, path: string) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: method === "GET" || method === "HEAD" ? undefined : "{}",
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as { message?: string } | null };
  };

  it("gets 403 'read-only' on every authenticated mutating route", async () => {
    const targets = ROUTES.filter((r) => MUTATING.has(r.method) && r.authenticated && !r.path.endsWith("/logout") && !r.path.endsWith("/refresh-token"));
    assert.ok(targets.length > 15);
    for (const r of targets) {
      const { status, body } = await call(r.method, concrete(r.path));
      assert.equal(status, 403, `${r.method} ${r.path} -> ${status}`);
      assert.equal(body?.message, READ_ONLY_MESSAGE, `${r.method} ${r.path}`);
    }
  });

  it("gets 403 on Better Auth's own mutating endpoints", async () => {
    for (const path of ["/change-password", "/revoke-sessions", "/revoke-other-sessions"]) {
      const { status, body } = await call("POST", `${API}/auth${path}`);
      assert.equal(status, 403, path);
      assert.equal(body?.message, READ_ONLY_MESSAGE, path);
    }
  });

  it("gets 403 (not read-only) on customer- and courier-only GET routes", async () => {
    const targets = ROUTES.filter((r) => r.method === "GET" && r.roles && !r.roles.includes(Role.ADMIN_VIEWER));
    assert.ok(targets.length >= 3);
    for (const r of targets) {
      const { status } = await call("GET", concrete(r.path));
      assert.equal(status, 403, `${r.method} ${r.path}`);
    }
  });
});
