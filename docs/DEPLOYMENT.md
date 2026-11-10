# Production deployment checklist (Vercel + Neon)

You run every step against production yourself. Nothing in this repo deploys, migrates or seeds production on its own.

Target: **Vercel serverless** (`api/index.ts` + `vercel.json`, region `sin1`), a **separate Neon production database** (not the one your local `.env` points at), Upstash Redis and Cloudinary in or near Singapore, and Stripe in **test mode** for the demo.

Order: [1 Neon](#1-neon-production-database) → [2 Migrate + seed](#2-migrate-and-seed-production-safely) → [3 Vercel project](#3-vercel-project) → [4 Env vars](#4-environment-variables-vercel--production) → [5 Stripe webhook](#5-stripe-webhook-for-the-live-url) → [6 Google](#6-google-oauth-for-the-live-url) → [7 Redeploy + verify](#7-post-deploy-verification).

---

## 1. Neon production database

1. Create a **new Neon project** (or a fresh branch) for production in **AWS Asia Pacific (Singapore) `aws-ap-southeast-1`**, the same area as the Vercel functions (`sin1`).
2. Copy two connection strings from **Connect**:

   | Name | Which one | Used by |
   |---|---|---|
   | `DATABASE_URL` | **Pooled** (host contains `-pooler`), `?sslmode=require` | The app at runtime (Vercel). Serverless instances open many short connections; the pooler (PgBouncer) absorbs them. |
   | `DIRECT_URL` | **Direct** (no `-pooler`), `?sslmode=require` | Prisma CLI only (`migrate deploy`, run from your machine). Migrations need a direct session (advisory locks, DDL). |

3. **Do not put these in your local `.env`.** Keep them in a separate file **outside the repo**, readable only by you:

   ```bash
   # ~/carrivo-prod.env   (chmod 600; never inside the project folder)
   NODE_ENV=production
   DATABASE_URL='<pooled connection string from Neon>'
   DIRECT_URL='<direct connection string from Neon>'
   ```

   `prisma.config.ts` and the app load `.env` through dotenv, which **never overrides variables that are already set**. So exporting this file into a subshell (step 2) makes every command use production. All other variables (Stripe, Google, …) still come from your local `.env`. The seed validates them but never calls those services.

## 2. Migrate and seed production safely

Run from the project folder, on the commit you are deploying.

### Before you start

- [ ] `git status` is clean, and `npm run build && npm test` pass.
- [ ] You have a way back: on a brand-new database there is nothing to lose. Otherwise create a Neon branch (snapshot) first: Neon → Branches → *Create branch* from `main`, named `pre-migrate-YYYYMMDD`.
- [ ] You have chosen a **strong `SEED_DEMO_PASSWORD`**. It must not be your local dev password. Generate one, for example `openssl rand -base64 24`, and store it in your password manager.
  - The demo password goes into your submission, so anyone who reads it can log in as the demo accounts. A short or reused password would also be easy to guess and could unlock other places you've used it.
- [ ] Optional but recommended: a separate **`SEED_ADMIN_PASSWORD`** for the admin account, so the public demo password does not open the real admin. Same strength rules; the seed refuses it if it equals the demo password. Reviewers can use the read-only `viewer@carrivo.dev` with the demo password instead.
  - The seed refuses (in production) anything shorter than 16 characters, using fewer than 3 kinds of characters (lowercase, uppercase, digits, symbols), containing words such as `password`, `carrivo`, `admin` or `demo`, or repeating one character 4+ times.

### Commands

Each block runs in a **subshell** `( … )`, so the production variables disappear when it ends.

```bash
# 2.1  Which database is this? (prints the host only, never credentials)
( set -a; . ~/carrivo-prod.env; set +a
  node -e 'for (const k of ["DATABASE_URL","DIRECT_URL"]) console.log(k, new URL(process.env[k]).hostname)' )
#  → expect the NEW production hosts (…-pooler… and the direct one), NOT your dev host.

# 2.2  Migration status (read-only)
( set -a; . ~/carrivo-prod.env; set +a; npx prisma migrate status )
#  → a fresh DB lists every migration as "not yet applied"; anything else, stop and check.

# 2.3  Apply migrations (uses DIRECT_URL)
( set -a; . ~/carrivo-prod.env; set +a; npm run db:deploy )
( set -a; . ~/carrivo-prod.env; set +a; npx prisma migrate status )   # → "Database schema is up to date!"

# 2.4  Seed. The host must be confirmed explicitly; the password is typed, not stored.
( set -a; . ~/carrivo-prod.env; set +a
  read -rs -p "Production demo password: " SEED_DEMO_PASSWORD; echo; export SEED_DEMO_PASSWORD
  read -rs -p "Admin password (Enter = use the demo password): " SEED_ADMIN_PASSWORD; echo
  [ -n "$SEED_ADMIN_PASSWORD" ] && export SEED_ADMIN_PASSWORD || unset SEED_ADMIN_PASSWORD
  export SEED_CONFIRM_DB_HOST='<the DATABASE_URL host printed by 2.1>'
  npm run db:seed )
```

The seed:
- refuses, writing nothing, if `SEED_CONFIRM_DB_HOST` doesn't match the `DATABASE_URL` host or the password is weak;
- is idempotent, so re-running it is safe;
- prints the emails and never the passwords.

**Rotating the demo password later** (for example if it leaked): run 2.4 again with the new password and `export SEED_RESET_DEMO_PASSWORDS=true`. This re-hashes the 6 demo accounts' passwords through Better Auth (the admin gets `SEED_ADMIN_PASSWORD` when it is set), revokes their sessions, and writes one `USER_PASSWORD_RESET_BY_SEED` audit row per account. The audit row holds the email only.

Never run `prisma migrate dev`, `migrate reset` or `db push` against production.

### Migrations in this release

- `20261108090000_admin_viewer_role` adds `ADMIN_VIEWER` to the `Role` enum.
- `20261108091000_weights_in_pounds` renames `weightKg`, `baseWeightKg`, `perKgFee`, `maxWeightKg` to the `…Lb` names, converts the stored values (× 2.20462, per-pound fee ÷ 2.20462) and rewrites the keys inside `priceBreakdown`. **This is a breaking API change**: deploy the frontend that sends `weightLb` in the same release. Take a Neon branch first; try it on that branch before `main`.

### Resetting demo data

`npm run db:reset-demo` (`prisma/reset-demo.ts`) replaces the demo data with a fresh US seed.

- **Deletes:** every shipment with its status history, pickup requests, payments, courier earnings and notifications; all audit logs; all pricing rules, hubs and zones; the demo and test accounts (`*@carrivo.dev`, `*@example.com`, `phase<n>.test.*`) with their sessions and logins.
- **Keeps:** every other registered user, and processed Stripe event ids (webhook idempotency). Proof images in Cloudinary are not deleted.
- **Refuses** (nothing deleted) unless `SEED_CONFIRM_DB_HOST` equals the `DATABASE_URL` host **and** `RESET_CONFIRM` is exactly `reset demo data on <that host>`, in every environment. It also refuses if a kept (non-demo) user has a courier profile, because deleting zones would orphan it.
- All deletes run in one transaction; the seed then runs with the same environment and its own checks.

```bash
# Take a Neon branch (snapshot) first: Neon → Branches → Create branch, e.g. pre-reset-YYYYMMDD.
( set -a; . ~/carrivo-prod.env; set +a
  node -e 'console.log(new URL(process.env.DATABASE_URL).hostname)'      # check the host
  read -rs -p "Production demo password: " SEED_DEMO_PASSWORD; echo; export SEED_DEMO_PASSWORD
  read -rs -p "Admin password (Enter = use the demo password): " SEED_ADMIN_PASSWORD; echo
  [ -n "$SEED_ADMIN_PASSWORD" ] && export SEED_ADMIN_PASSWORD || unset SEED_ADMIN_PASSWORD
  export SEED_CONFIRM_DB_HOST='<the host printed above>'
  export RESET_CONFIRM="reset demo data on $SEED_CONFIRM_DB_HOST"
  npm run db:reset-demo )
```

Afterwards: the demo users get new ids, so existing sessions and frontend caches for them are gone; sign in again.

## 3. Vercel project

1. **Vercel → Add New → Project** → import your `carrivo-backend` repository.
   - **Framework Preset:** Other. `vercel.json` already sets `"framework": null`.
   - **Root directory:** `./`.
   - **Build / Output / Install commands:** leave them empty (defaults). Vercel runs `npm install`; `postinstall` runs `prisma generate`.
   - **Node.js version** (Settings → Build and Deployment): 22.x or 24.x (`engines` requires ≥ 22.12).
2. **Settings → Functions**: Fluid compute on (the default for new projects). The region comes from `vercel.json` (`sin1`). Leave memory at the default.
3. The first deployment will fail at runtime until the env vars are set; that's expected. Note the production domain (`https://<project>.vercel.app`), then set the env vars (step 4) and **redeploy**.

### What `vercel.json` and `api/index.ts` do (verified)

| Item | Value | Why |
|---|---|---|
| `framework` | `null` | No preset. Only `api/index.ts` becomes a function, and `src/server.ts` (`app.listen`) is never used on Vercel. |
| `rewrites` | `/(.*)` → `/api` | Every path (`/`, `/api/v1/...`) reaches the one Express function. The original URL is preserved, so Express routing works unchanged. |
| `regions` | `["sin1"]` | Next to Neon (`ap-southeast-1`) and Upstash. Each request makes several database round-trips. |
| `functions["api/index.ts"].maxDuration` | `30` s | Covers the slowest path: a Cloudinary upload, 20 s timeout. |
| Build | `postinstall` = `prisma generate` | Generates the client into `src/generated/` (gitignored) during install. Vercel compiles `api/index.ts` and everything it imports itself; `dist/` is not used. Run `npm run build` and `npx tsc --noEmit` locally before deploying. |
| `.vercelignore` | `scripts/`, `docs/`, `dist/`, `.env*`, tests | Dev-only code is never uploaded. |

**Checked locally:**
- **Bundle contents:** an import-graph walk from `api/index.ts` reaches 132 files, all under `src/app*` and `src/generated`. `scripts/dev-mark-paid.ts`, `scripts/smoke.ts`, `prisma/seed.ts` and the tests are not reachable.
- **Prisma client:** its query compiler is a base64 `.mjs` module loaded by a literal `import()`, which Vercel's tracer includes. There are no `.wasm` or file reads to bundle.
- **No env at build:** `prisma generate` succeeds with no environment variables at all.
- **Mark-paid helper:** it has no HTTP route, is excluded from the upload, and refuses to run when `NODE_ENV=production` or `VERCEL` is set. In the app, a payment becomes PAID only through the verified webhook or the server-side session lookup.

**Not checked locally:** `vercel build` needs the project linked. If you want a local build before deploying, after creating the project:

```bash
npx vercel link            # choose the NEW carrivo-backend project
npx vercel pull --environment=production
npx vercel build --prod    # builds into .vercel/output, deploys nothing
```

### Things that fail on Vercel, and how to avoid them

| Symptom | Cause | Avoid it |
|---|---|---|
| Every request 500 `FUNCTION_INVOCATION_FAILED`; logs say `Invalid environment variables: - NAME: …` | A required env var is missing or invalid. The app validates them at startup; the log lists names only. | Set the full list in §4 for **Production**, then redeploy. |
| Preview deployments crash | Env vars set for Production only | Ignore preview URLs, or add the same vars to Preview (with test keys). |
| `413 FUNCTION_PAYLOAD_TOO_LARGE` (Vercel page, not our JSON envelope) | Request body > 4.5 MB (Vercel's limit) | Our upload limit is 4 MB, so it only happens with oversized files; the frontend should compress photos. |
| Webhook returns 400 "Invalid Stripe signature", and logs show `webhook raw body unavailable` | Body parsed before `express.raw` | Middleware order is correct in `app.ts` (webhook route before `express.json()`). If you ever see this log line, check that nothing was added above it. |
| Webhook 400 with no such log line | Wrong `STRIPE_WEBHOOK_SECRET`: the CLI's local secret instead of the Dashboard endpoint's | Use the endpoint's own signing secret (§5). |
| Google `redirect_uri_mismatch` | Live callback not registered, or `BETTER_AUTH_URL` ≠ the real domain | §6. `BETTER_AUTH_URL` must be exactly `https://<project>.vercel.app`, with no path or trailing slash. |
| Browser calls blocked by CORS | Frontend origin missing from `CORS_ORIGINS` | Add the exact origin (scheme + host, no slash). |
| Email links or Google landing go to `localhost:3000` | `FRONTEND_URL` not set (it defaults to localhost) | Set `FRONTEND_URL` and the success/cancel URLs. |
| Rate limits behave per instance | Upstash vars missing (in-memory fallback) | Set both Upstash vars. |

## 4. Environment variables (Vercel → Production)

Settings → Environment Variables, scope **Production**. Names only, with no values here. Values marked "new" must not be copied from development.

| Name | Value / note |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Neon production **pooled** URL |
| `BETTER_AUTH_SECRET` | **new**, `openssl rand -base64 32`, at least 32 characters |
| `BETTER_AUTH_URL` | `https://<project>.vercel.app` |
| `BFF_SHARED_SECRET` | **new**, `openssl rand -base64 48`, at least 32 characters. **Required in production** (the app refuses to start without it). Set the **same value** in the frontend project. See [Per-visitor rate limits](#per-visitor-rate-limits-behind-the-frontend-bff) |
| `CORS_ORIGINS` | `http://localhost:3000,https://<frontend>.vercel.app` (add the future frontend now; exact origins, comma-separated) |
| `FRONTEND_URL` | `https://<frontend>.vercel.app` (origin only) |
| `FRONTEND_SUCCESS_URL` | `https://<frontend>.vercel.app/payment/success` |
| `FRONTEND_CANCEL_URL` | `https://<frontend>.vercel.app/payment/cancel` |
| `GOOGLE_CLIENT_ID` | OAuth client id (can be the same client as development) |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |
| `STRIPE_SECRET_KEY` | the Stripe secret key from test mode (test mode for the demo) |
| `STRIPE_WEBHOOK_SECRET` | **new**, from the Dashboard endpoint in §5 (not the `stripe listen` one) |
| `UPSTASH_REDIS_REST_URL` | Upstash REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash REST token |
| `REDIS_KEY_PREFIX` | `carrivo:prod:` (must differ from dev if you share a Redis database) |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret |
| `RESEND_API_KEY` | Resend key (optional; without it notifications are stored, not emailed) |
| `EMAIL_FROM` | `Carrivo <noreply@your-verified-domain>` (optional; see Resend below) |

### Per-visitor rate limits behind the frontend BFF

The Next.js frontend calls this API from its own server, so without help every visitor would arrive from the
frontend's Vercel IPs and share one 300-requests-per-15-minutes bucket (20 failed logins for the auth limiter).
The frontend therefore sends two headers on every server-side call:

| Header | Value |
|---|---|
| `x-bff-secret` | `BFF_SHARED_SECRET` |
| `x-client-ip` | The visitor's IP address |

Both the global limiter and the auth limiter (`src/app/middlewares/rateLimiter.ts`) key each request through
`rateLimitKey()` in `src/app/utils/clientKey.ts`:

- `x-client-ip` is used **only** if `x-bff-secret` matches `BFF_SHARED_SECRET` (constant-time compare) **and** the
  value is a valid IPv4/IPv6 address (`net.isIP`).
- In every other case (no secret, wrong secret, missing or garbage IP, repeated headers) the key is the connecting
  IP (`req.ip`, correct behind Vercel thanks to `trust proxy`), exactly as before. A browser can never pick its own key.
- Limits are unchanged; IPv6 addresses are grouped by subnet exactly like express-rate-limit's default.

Keep the secret server-side in both projects (never a `NEXT_PUBLIC_` variable) and rotate it in both at the same time.

**Never set in Vercel:**
- `DEV_ALLOW_MARK_PAID`
- `SEED_DEMO_PASSWORD`, `SEED_ADMIN_PASSWORD`, `SEED_CONFIRM_DB_HOST`, `SEED_RESET_DEMO_PASSWORDS`, `RESET_CONFIRM`
- `SMOKE_*`
- `DIRECT_URL` (only the CLI on your machine needs it)
- `PORT`

**Service settings:**
- **Upstash:** a Redis database in `ap-southeast-1` (Singapore). The rate limiter makes one REST call per request, so distance adds latency to every call. Leave eviction off. Use the REST URL and token (not the `redis://` URL).
- **Cloudinary:** images go to `carrivo/proof-of-delivery` with signed server uploads. No upload preset or unsigned uploads are needed. The image URLs are public but unguessable (by design).
- **Resend:** the default sender `onboarding@resend.dev` only delivers to your own Resend account address. Other recipients are recorded `FAILED`, and the request still succeeds. To email the demo users, verify a domain in Resend and set `EMAIL_FROM` to an address on it.

## 5. Stripe webhook for the live URL

Stripe Dashboard, **test mode** → Developers → **Webhooks** → *Add destination / endpoint*:

1. **Endpoint URL:** `https://<project>.vercel.app/api/v1/payments/webhook`
2. **API version:** `2026-09-30.endive`, the version the SDK pins (`src/app/lib/stripe.ts`). Event payloads then have the same shape the code expects.
3. **Events:** select exactly these 7:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `checkout.session.expired`
   - `payment_intent.payment_failed`
   - `charge.refunded`
   - `refund.failed`
4. Save, reveal the endpoint's **signing secret**, set it as `STRIPE_WEBHOOK_SECRET` in Vercel, and **redeploy**.
   - This secret belongs to this endpoint only. It differs from your `stripe listen` secret, and the local one stays in your `.env`.
5. Test: make a test payment (§7). Then Webhooks → your endpoint → *Event deliveries* should show `200`.

If you ever go live, live mode needs its own endpoint, its own secret and a live-mode secret key. That isn't needed for the assignment.

## 6. Google OAuth for the live URL

Google Cloud Console → APIs & Services:

1. **Credentials** → your OAuth client → **Authorized redirect URIs**, add `https://<project>.vercel.app/api/v1/auth/callback/google`. Keep the localhost one for development. No JavaScript origins are needed.
2. **OAuth consent screen / Audience** → **Publish app** (Testing → In production).
   - While it is in Testing, only the listed test users can sign in, and everyone else gets "Access blocked".
   - We request only `openid`, `email` and `profile`, which are non-sensitive scopes, so publishing needs no Google verification review.
   - Add an app name, support email and the authorized domain `vercel.app` if Google asks.
3. `BETTER_AUTH_URL` (Vercel) must be exactly the live API origin. Better Auth builds the callback URL from it. Because it is `https://`, Better Auth marks its cookies `Secure` automatically.

## 7. Post-deploy verification

Replace `API=https://<project>.vercel.app`.

- [ ] `curl -s $API/api/v1/health` returns `"database":"up"`. The `x-vercel-id` response header contains `sin1`.
- [ ] `curl -s $API/api/v1/nope` returns the 404 JSON envelope.
- [ ] **Smoke test from your machine:**

  ```bash
  read -rs -p "Demo password: " SMOKE_PASSWORD; echo; export SMOKE_PASSWORD
  npm run smoke -- $API
  ```

  - Expect `… passed, 0 failed — PASS`. It is read-only and never creates payments or sends emails.
  - Each run makes about 60 requests. The global limit is 300 requests per 15 minutes per IP, so don't loop it.
- [ ] **Postman:** set `baseUrl` to `$API/api/v1` and `demoPassword`, run the four logins (admin, viewer, courier, customer), then run the **RBAC matrix** folder (including **Admin Viewer (read-only)**). All tests should pass.
- [ ] **Stripe:** as customer1:
  1. Create a shipment, initiate payment and pay with `4242 4242 4242 4242`.
  2. In the Dashboard, the endpoint shows a `checkout.session.completed` delivery with `200`.
  3. The payment is `PAID` (`GET /payments/my`) and a PAYMENT_RECEIVED notification exists.
- [ ] **Google:** open `$API/api/v1/auth/google?challenge=<challenge>` (see README → manual test).
  1. The account picker appears, and you land on `FRONTEND_URL/auth/google/callback?code=…`.
  2. The exchange returns a token.
  3. Cancelling at Google lands on `?error=google_cancelled`.
- [ ] **Cookies:** in browser devtools on the Google flow, the `better-auth.*` cookies set by the API are `Secure` and `HttpOnly`.
- [ ] **CORS:** run `curl -si -X OPTIONS $API/api/v1/zones -H "Origin: https://<frontend>.vercel.app" -H "Access-Control-Request-Method: GET" | grep -i access-control-allow-origin`. It should echo the origin. An unlisted origin should get 403.
- [ ] **Proof upload:** as an assigned courier, upload a small JPEG to `POST /shipments/:id/proof` with the shipment OUT_FOR_DELIVERY. The response has a `res.cloudinary.com` URL.
- [ ] **Per-visitor rate limits:** the `RateLimit` header's `r=` (remaining) value is counted per key. Read the secret without echoing it, then compare two forwarded IPs:

  ```bash
  read -rs -p "BFF secret: " BFF; echo
  for ip in 198.51.100.1 198.51.100.2; do
    curl -s -o /dev/null -D - "$API/api/v1/zones" -H "x-bff-secret: $BFF" -H "x-client-ip: $ip" | grep -i '^ratelimit:'
  done
  curl -s -o /dev/null -D - "$API/api/v1/zones" -H "x-client-ip: 198.51.100.1" | grep -i '^ratelimit:'   # no secret: your own IP's bucket
  unset BFF
  ```

  Each forwarded IP starts near `r=299`; the last call (no secret) shows your own IP's count instead of continuing either forwarded bucket.
- [ ] **Logs:** Vercel → Logs shows no `Invalid environment variables`, no `webhook raw body unavailable`, and no stack traces in responses (`NODE_ENV=production`).
- [ ] **Submission:** fill in the README submission block: live URL, Postman docs link, video. Passwords stay out of the README; give them only where the assignment asks for them.
