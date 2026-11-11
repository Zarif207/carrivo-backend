import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

// No database or Redis here: point the client at a closed local port, so the test also proves the
// API root answers while the database is down.
process.env["DATABASE_URL"] = "postgresql://test@127.0.0.1:1/none";
process.env["DIRECT_URL"] = "postgresql://test@127.0.0.1:1/none";
process.env["UPSTASH_REDIS_REST_URL"] = "";
process.env["UPSTASH_REDIS_REST_TOKEN"] = "";

const { default: app } = await import("../../../app.js");
const { moduleRoutes } = await import("../../routes/index.js");
const { AUTH_BASE_PATH } = await import("../../lib/auth.js");
const { RootService, API_BASE_PATH } = await import("./root.service.js");
const packageJson = (await import("../../../../package.json", { with: { type: "json" } })).default;

const SECRET_LOOKING = /secret|token|password|passwd|api[-_]?key|private|credential|database|dsn|cookie|session|stripe|redis|resend|cloudinary|_url$/i;

/** Every key in a JSON value, nested ones included. */
const keysOf = (value: unknown): string[] =>
  value && typeof value === "object" ? Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]) : [];

describe("API root: GET / and GET /api/v1", () => {
  let base = "";
  let server: ReturnType<typeof app.listen>;

  before(async () => {
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  for (const path of ["/api/v1", "/api/v1/", "/"]) {
    it(`${path} answers 200 JSON in the response envelope, without touching the database`, async () => {
      const started = Date.now();
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
      // helmet ran (security headers) and the global limiter counted it
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.ok(response.headers.get("ratelimit-limit") ?? response.headers.get("ratelimit-policy") ?? response.headers.get("x-ratelimit-limit"));
      const body = (await response.json()) as { success: boolean; message: string; data: Record<string, unknown> };
      assert.equal(body.success, true);
      assert.equal(body.message, "Carrivo API is running");
      assert.deepEqual(Object.keys(body.data).sort(), ["docs", "endpoints", "environment", "health", "name", "status", "timestamp", "version"]);
      assert.equal(body.data["name"], "Carrivo API");
      assert.equal(body.data["version"], packageJson.version);
      assert.equal(body.data["status"], "ok");
      assert.ok(body.data["environment"] === "production" || body.data["environment"] === "development");
      assert.match(String(body.data["docs"]), /^https:\/\/github\.com\/.+\/docs\/api\.md$/);
      assert.equal(body.data["health"], "/api/v1/health");
      assert.ok(!Number.isNaN(Date.parse(String(body.data["timestamp"]))));
      assert.ok(Date.now() - started < 2000, "answers fast (no database wait)");
    });
  }

  it("has no secret-looking keys or values", async () => {
    const body = (await (await fetch(`${base}/api/v1`)).json()) as { data: unknown };
    const offending = keysOf(body.data).filter((key) => SECRET_LOOKING.test(key));
    assert.deepEqual(offending, []);
    const text = JSON.stringify(body);
    for (const name of ["DATABASE_URL", "postgresql://", "BETTER_AUTH_SECRET", "sk_test", "whsec_"]) assert.ok(!text.includes(name), name);
  });

  it("lists the real base paths, each mounted in the route table", () => {
    const { endpoints } = RootService.getInfo("development", new Date(0));
    assert.equal(endpoints.auth, AUTH_BASE_PATH);
    const mounted = new Set(moduleRoutes.map((route) => `${API_BASE_PATH}${route.path}`));
    for (const [name, path] of Object.entries(endpoints)) if (name !== "auth") assert.ok(mounted.has(path), `${name}: ${path}`);
    assert.equal(endpoints.courierApplications, "/api/v1/courier-applications");
  });

  it("environment is only ever production or development", () => {
    assert.equal(RootService.getInfo("production", new Date(0)).environment, "production");
    for (const value of ["development", "test", "staging", undefined]) assert.equal(RootService.getInfo(value, new Date(0)).environment, "development");
  });

  it("does not shadow the routes under it, and unknown paths still 404", async () => {
    assert.equal((await fetch(`${base}/api/v1/nope`)).status, 404);
    const health = await fetch(`${base}/api/v1/health`);
    assert.notEqual(health.status, 404); // the health route still answers (its database probe reports "down" here)
  });
});
