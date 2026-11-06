/**
 * Read-only smoke test against ANY deployment (local or live):
 *
 *   SMOKE_PASSWORD='<demo password>' npm run smoke -- https://<api>.vercel.app
 *   SMOKE_PASSWORD='<demo password>' npm run smoke -- http://localhost:5000
 *
 * The base URL may include /api/v1 or not. Credentials come from env vars only
 * (never .env, never arguments) and are never printed:
 *   SMOKE_PASSWORD                     shared demo password (seeded accounts), or per role:
 *   SMOKE_ADMIN_PASSWORD / SMOKE_COURIER_PASSWORD / SMOKE_CUSTOMER_PASSWORD
 *   SMOKE_ADMIN_EMAIL / SMOKE_COURIER_EMAIL / SMOKE_CUSTOMER_EMAIL   (default: seeded demo emails)
 *   SMOKE_TRACKING_ID                  public tracking id to look up (default: CRV-261101-SEED05)
 *   SMOKE_OTHER_TRACKING_ID            a shipment owned by ANOTHER customer and NOT assigned
 *                                      to the courier above (default: CRV-261101-SEED03)
 *
 * SAFE FOR PRODUCTION: it only sends GET requests, plus the few non-GET requests
 * in SAFE_WRITES below. Those are login/logout, or probes that MUST be refused, and
 * every probe carries an invalid body, so even a broken role check would stop at
 * validation (400): no shipment, payment, Stripe session, upload or email can be
 * created. The only rows it writes are the login sessions (revoked by the logouts
 * at the end); it writes no audit rows.
 */
export {};

type Role = "ADMIN" | "COURIER" | "CUSTOMER";
type Outcome = "PASS" | "FAIL" | "SKIP";

interface Envelope {
  success?: boolean;
  message?: string;
  data?: unknown;
  meta?: { page?: number; limit?: number; total?: number; totalPages?: number };
  errors?: unknown[];
}

interface Reply {
  status: number;
  body: Envelope | null;
  ms: number;
}

interface Row {
  check: string;
  expected: string;
  got: string;
  outcome: Outcome;
}

// ───────── arguments & config ─────────

const rawBase = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
if (!rawBase || !/^https?:\/\//.test(rawBase)) {
  console.error("Usage: npm run smoke -- <baseUrl>   e.g. npm run smoke -- https://<api>.vercel.app");
  process.exit(2);
}
const origin = rawBase.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
const API = `${origin}/api/v1`;
const TIMEOUT_MS = 20_000; // first request may hit a cold start

const env = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
};

const ACCOUNTS: Record<Role, { email: string; password: string | undefined }> = {
  ADMIN: { email: env("SMOKE_ADMIN_EMAIL") ?? "admin@carrivo.dev", password: env("SMOKE_ADMIN_PASSWORD") ?? env("SMOKE_PASSWORD") },
  COURIER: { email: env("SMOKE_COURIER_EMAIL") ?? "courier1@carrivo.dev", password: env("SMOKE_COURIER_PASSWORD") ?? env("SMOKE_PASSWORD") },
  CUSTOMER: { email: env("SMOKE_CUSTOMER_EMAIL") ?? "customer1@carrivo.dev", password: env("SMOKE_CUSTOMER_PASSWORD") ?? env("SMOKE_PASSWORD") },
};
const TRACKING_ID = env("SMOKE_TRACKING_ID") ?? "CRV-261101-SEED05";
const OTHER_TRACKING_ID = env("SMOKE_OTHER_TRACKING_ID") ?? "CRV-261101-SEED03";
const RANDOM_UUID = "019a0000-0000-7000-8000-000000000000";

// ───────── HTTP (with the write allow-list) ─────────

/** The ONLY non-GET requests this script may send. Anything else throws before sending. */
const SAFE_WRITES = new Set([
  "POST /auth/login",
  "POST /auth/logout",
  "POST /pricing/estimate", // always with an invalid body → 400
  "POST /zones", // forbidden-role probe, invalid body
  "POST /shipments", // forbidden-role probe, invalid body
  "POST /payments/initiate", // forbidden-role probe, invalid body
  "PATCH /shipments/:id/status", // forbidden-role probe, invalid body
]);

const routeKey = (method: string, path: string): string =>
  `${method} ${path.split("?")[0]?.replace(/\/[0-9a-f-]{36}(?=\/|$)/g, "/:id")}`;

const tokens: Partial<Record<Role, string>> = {};

const call = async (method: string, path: string, options: { as?: Role; token?: string; body?: unknown } = {}): Promise<Reply> => {
  if (method !== "GET" && !SAFE_WRITES.has(routeKey(method, path))) {
    throw new Error(`smoke refused to send ${routeKey(method, path)}: not in the read-only allow-list`);
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  const bearer = options.token ?? (options.as ? tokens[options.as] : undefined);
  if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const started = Date.now();
  const response = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  let body: Envelope | null = null;
  try {
    body = text ? (JSON.parse(text) as Envelope) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body, ms: Date.now() - started };
};

// ───────── checks ─────────

const rows: Row[] = [];
const record = (check: string, expected: string, got: string, ok: boolean | "skip"): void => {
  rows.push({ check, expected, got, outcome: ok === "skip" ? "SKIP" : ok ? "PASS" : "FAIL" });
};

/** Keys that must never appear in any response we inspect. */
const FORBIDDEN_KEYS = /^(password|passwordHash|accessToken|refreshToken|idToken|secret|stripeSecret)$/i;
const leakedKeys = (value: unknown, found: string[] = []): string[] => {
  if (Array.isArray(value)) value.forEach((item) => leakedKeys(item, found));
  else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.test(key)) found.push(key);
      leakedKeys(inner, found);
    }
  }
  return found;
};

const describe = (reply: Reply): string => {
  const message = reply.body?.message ? ` ${reply.body.message.slice(0, 60)}` : "";
  return `${reply.status}${message}`;
};

const isEnvelope = (reply: Reply, success: boolean): boolean =>
  reply.body !== null && reply.body.success === success && typeof reply.body.message === "string";

/** Runs one check; a network error or thrown error is a FAIL, never a crash. */
const check = async (name: string, expected: string, run: () => Promise<{ ok: boolean; got: string }>): Promise<void> => {
  try {
    const { ok, got } = await run();
    record(name, expected, got, ok);
  } catch (error) {
    record(name, expected, error instanceof Error ? `error: ${error.message.slice(0, 70)}` : "error", false);
  }
};

const expectStatus = (name: string, method: string, path: string, status: number, options: { as?: Role; token?: string; body?: unknown } = {}) =>
  check(name, `${status}${status >= 400 ? " envelope" : ""}`, async () => {
    const reply = await call(method, path, options);
    return { ok: reply.status === status && isEnvelope(reply, status < 400), got: describe(reply) };
  });

/** The page of items: `data` itself, or the one array inside it (e.g. earnings: { summary, earnings[] }). */
const listItems = (data: unknown): unknown[] | null => {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const arrays = Object.values(data).filter(Array.isArray);
    if (arrays.length === 1) return arrays[0] ?? null;
  }
  return null;
};

/** A list endpoint: 200, success envelope, an array page, pagination meta, no secret keys. */
const expectList = (name: string, path: string, as: Role, paginated = true) =>
  check(name, paginated ? "200 list + meta" : "200 object", async () => {
    const reply = await call("GET", path, { as });
    const leaks = leakedKeys(reply.body?.data);
    const items = listItems(reply.body?.data);
    const shapeOk = paginated
      ? items !== null && typeof reply.body?.meta?.total === "number"
      : typeof reply.body?.data === "object" && reply.body?.data !== null;
    const got =
      reply.status !== 200
        ? describe(reply)
        : leaks.length > 0
          ? `200 but leaked keys: ${[...new Set(leaks)].join(",")}`
          : paginated
            ? `200 (${items ? items.length : "?"} of ${reply.body?.meta?.total ?? "?"})`
            : "200";
    return { ok: reply.status === 200 && isEnvelope(reply, true) && shapeOk && leaks.length === 0, got };
  });

const findShipmentId = async (trackingId: string): Promise<string | null> => {
  const reply = await call("GET", `/shipments?searchTerm=${encodeURIComponent(trackingId)}&limit=5`, { as: "ADMIN" });
  const list = Array.isArray(reply.body?.data) ? (reply.body.data as { id?: string; trackingId?: string }[]) : [];
  return list.find((s) => s.trackingId === trackingId)?.id ?? null;
};

const main = async (): Promise<void> => {
  console.log(`\nCarrivo smoke test → ${API}\n(read-only; passwords and tokens are never printed)\n`);

  // 1. Public
  await check("health", "200, database up", async () => {
    const reply = await call("GET", "/health");
    const data = reply.body?.data as { database?: string } | undefined;
    return { ok: reply.status === 200 && isEnvelope(reply, true) && data?.database === "up", got: `${reply.status} db=${data?.database ?? "?"} ${reply.ms}ms` };
  });
  await expectStatus("unknown route → 404", "GET", "/this-route-does-not-exist", 404);
  await check("public tracking", "200, no emails/proof", async () => {
    const reply = await call("GET", `/tracking/${TRACKING_ID}`);
    const text = JSON.stringify(reply.body?.data ?? {});
    const privateData = /@|proofOfDelivery|customerId|phone/i.test(text);
    return { ok: reply.status === 200 && isEnvelope(reply, true) && !privateData, got: privateData ? `${reply.status} exposes private fields` : describe(reply) };
  });
  await expectStatus("tracking unknown id → 404", "GET", "/tracking/CRV-000000-NOPE00", 404);
  await check("validation error → 400", "400 + errors[]", async () => {
    const reply = await call("POST", "/pricing/estimate", { body: { weightKg: -1 } });
    const ok = reply.status === 400 && isEnvelope(reply, false) && Array.isArray(reply.body?.errors) && reply.body.errors.length > 0;
    return { ok, got: `${reply.status} errors=${Array.isArray(reply.body?.errors) ? reply.body.errors.length : "?"}` };
  });
  await expectStatus("no token → 401", "GET", "/users/me", 401);
  await expectStatus("invalid token → 401", "GET", "/users/me", 401, { token: "not-a-real-session-token" });

  // 2. Login (the only writes: one session per role, revoked at the end)
  for (const role of ["ADMIN", "COURIER", "CUSTOMER"] as const) {
    const account = ACCOUNTS[role];
    if (!account.password) {
      record(`login ${role.toLowerCase()}`, "200 + token", `skipped: set SMOKE_PASSWORD or SMOKE_${role}_PASSWORD`, false);
      continue;
    }
    await check(`login ${role.toLowerCase()} (${account.email})`, "200 + token", async () => {
      const reply = await call("POST", "/auth/login", { body: { email: account.email, password: account.password } });
      const data = reply.body?.data as { token?: string; user?: { role?: string } } | undefined;
      if (reply.status === 200 && data?.token) tokens[role] = data.token;
      const roleOk = data?.user?.role === role;
      return { ok: reply.status === 200 && Boolean(data?.token) && roleOk, got: reply.status === 200 ? `200 role=${data?.user?.role ?? "?"}` : describe(reply) };
    });
  }

  const has = (role: Role): boolean => Boolean(tokens[role]);
  const skip = (name: string, role: Role): void => record(name, "-", `skipped: no ${role.toLowerCase()} token`, "skip");

  // 3. Identity
  for (const role of ["ADMIN", "COURIER", "CUSTOMER"] as const) {
    const name = `GET /users/me as ${role.toLowerCase()}`;
    if (!has(role)) {
      skip(name, role);
      continue;
    }
    await check(name, `200 role=${role}`, async () => {
      const reply = await call("GET", "/users/me", { as: role });
      const data = reply.body?.data as { role?: string } | undefined;
      const leaks = leakedKeys(reply.body?.data);
      return { ok: reply.status === 200 && data?.role === role && leaks.length === 0, got: `${reply.status} role=${data?.role ?? "?"}` };
    });
  }

  // 4. Role checks (403). Bodies are invalid on purpose (see header).
  const forbidden: [Role, string, string, unknown?][] = [
    ["CUSTOMER", "GET", "/admin/users"],
    ["CUSTOMER", "GET", "/admin/audit-logs"],
    ["CUSTOMER", "POST", "/zones", {}],
    ["CUSTOMER", "GET", "/couriers/me/tasks"],
    ["CUSTOMER", "PATCH", `/shipments/${RANDOM_UUID}/status`, {}],
    ["COURIER", "GET", "/admin/dashboard-stats"],
    ["COURIER", "POST", "/shipments", {}],
    ["COURIER", "POST", "/payments/initiate", {}],
    ["COURIER", "GET", "/pricing"],
    ["ADMIN", "GET", "/couriers/me/tasks"],
    ["ADMIN", "POST", "/shipments", {}],
    ["ADMIN", "GET", "/payments/my"],
  ];
  for (const [role, method, path, body] of forbidden) {
    const name = `${role.toLowerCase()} ${method} ${path.replace(RANDOM_UUID, ":id")} → 403`;
    if (!has(role)) skip(name, role);
    else await expectStatus(name, method, path, 403, { as: role, ...(body !== undefined ? { body } : {}) });
  }

  // 5. Ownership (404, not 403: other users' shipments are invisible)
  if (has("ADMIN")) {
    const otherId = await findShipmentId(OTHER_TRACKING_ID).catch(() => null);
    if (!otherId) record(`find ${OTHER_TRACKING_ID} as admin`, "found", "not found (set SMOKE_OTHER_TRACKING_ID)", false);
    else {
      if (has("CUSTOMER")) await expectStatus(`customer reads another's shipment → 404`, "GET", `/shipments/${otherId}`, 404, { as: "CUSTOMER" });
      if (has("COURIER")) await expectStatus(`courier reads an unassigned shipment → 404`, "GET", `/shipments/${otherId}`, 404, { as: "COURIER" });
      await expectStatus("admin reads it → 200", "GET", `/shipments/${otherId}`, 200, { as: "ADMIN" });
    }
  }
  if (has("ADMIN")) await expectStatus("unknown shipment id → 404", "GET", `/shipments/${RANDOM_UUID}`, 404, { as: "ADMIN" });

  // 6. Read-only pass over the list endpoints
  const lists: [Role, string, boolean?][] = [
    ["ADMIN", "/shipments?limit=5"],
    ["ADMIN", "/zones?limit=5"],
    ["ADMIN", "/hubs?limit=5"],
    ["ADMIN", "/pricing?limit=5"],
    ["ADMIN", "/couriers?limit=5"],
    ["ADMIN", "/admin/users?limit=5"],
    ["ADMIN", "/admin/audit-logs?limit=5"],
    ["ADMIN", "/admin/payments?limit=5"],
    ["ADMIN", "/admin/dashboard-stats", false],
    ["ADMIN", "/notifications/my?limit=5"],
    ["COURIER", "/couriers/me/tasks?limit=5"],
    ["COURIER", "/couriers/me/earnings?limit=5"],
    ["COURIER", "/shipments?limit=5"],
    ["COURIER", "/notifications/my?limit=5"],
    ["CUSTOMER", "/shipments?limit=5"],
    ["CUSTOMER", "/payments/my?limit=5"],
    ["CUSTOMER", "/notifications/my?limit=5"],
  ];
  for (const [role, path, paginated] of lists) {
    const name = `${role.toLowerCase()} GET ${path.split("?")[0]}`;
    if (!has(role)) skip(name, role);
    else await expectList(name, path, role, paginated ?? true);
  }

  // 7. Logout (revokes the smoke sessions); the old token must then be rejected
  for (const role of ["ADMIN", "COURIER", "CUSTOMER"] as const) {
    if (!has(role)) continue;
    await check(`logout ${role.toLowerCase()} + token rejected`, "200 then 401", async () => {
      const out = await call("POST", "/auth/logout", { as: role });
      const after = await call("GET", "/users/me", { as: role });
      return { ok: out.status === 200 && after.status === 401, got: `${out.status} then ${after.status}` };
    });
  }
};

const printTable = (): void => {
  const width = (key: keyof Row, min: number): number => Math.max(min, ...rows.map((row) => row[key].length));
  const w = { check: width("check", 5), expected: width("expected", 8), got: Math.min(width("got", 3), 60) };
  const line = (cells: string[]): string => cells.join("  ");
  const pad = (text: string, size: number): string => (text.length > size ? `${text.slice(0, size - 1)}…` : text.padEnd(size));
  console.log(line(["  #", pad("CHECK", w.check), pad("EXPECTED", w.expected), pad("GOT", w.got), "RESULT"]));
  rows.forEach((row, index) => {
    console.log(line([String(index + 1).padStart(3), pad(row.check, w.check), pad(row.expected, w.expected), pad(row.got, w.got), row.outcome]));
  });
  const count = (outcome: Outcome): number => rows.filter((row) => row.outcome === outcome).length;
  console.log(`\n${count("PASS")} passed, ${count("FAIL")} failed, ${count("SKIP")} skipped — ${count("FAIL") === 0 ? "PASS" : "FAIL"}\n`);
};

main()
  .catch((error: unknown) => record("smoke runner", "no crash", error instanceof Error ? error.message.slice(0, 70) : "error", false))
  .finally(() => {
    printTable();
    process.exitCode = rows.some((row) => row.outcome === "FAIL") ? 1 : 0;
  });
