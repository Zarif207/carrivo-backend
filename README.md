# Carrivo Backend

REST API for **Carrivo**, a courier & logistics platform. Customers create, pay for and track shipments; couriers pick them up and deliver them; admins run hubs, zones, pricing, users, assignments and reports.

```
Project Name    : Carrivo (Courier & Logistics Platform)
Backend Repo    : https://github.com/Zarif207/carrivo-backend
Live API        : https://<your-api>.vercel.app
API Docs        : https://documenter.getpostman.com/view/xyz
Demo Video      : https://drive.google.com/file/d/xyz/view
Admin Email     : admin@carrivo.dev
Admin Password  : ******** (placeholder only)
```

## Contents

- [Features](#features)
- [Tech stack](#tech-stack)
- [Architecture](#architecture)
- [Data model (ERD summary)](#data-model-erd-summary)
- [Shipment status flow](#shipment-status-flow)
- [Roles and permissions](#roles-and-permissions)
- [API endpoints](#api-endpoints)
- [Environment variables](#environment-variables)
- [Local setup](#local-setup)
- [Seeding and demo accounts](#seeding-and-demo-accounts)
- [Testing](#testing)
- [Stripe (test mode) locally](#stripe-test-mode-locally)
- [Authentication and Google sign-in](#authentication)
- [Deployment](#deployment)

## Features

- **Email/password and Google sign-in** (Better Auth) with Bearer tokens, session rotation and logout. Role is never client-settable; everyone signs up as `CUSTOMER`.
- **Shipments**: server-side pricing (zone pair + service type + weight), unique tracking ids, edit and cancel before pickup, pickup scheduling, admin assignment with concurrency-safe courier checks, and a single state machine for every status change.
- **Public tracking** by tracking id, which shows the status timeline only (no personal data).
- **Stripe Checkout** (test mode, USD): the payment is confirmed only by the verified webhook or a server-side session lookup. Idempotent event handling and refunds on cancellation.
- **Couriers**: assigned tasks, availability, earnings, and proof-of-delivery photo upload (Cloudinary).
- **Notifications**: stored in-app notifications and lifecycle emails (Resend), sent after the transaction commits. Email failures never fail a request.
- **Admin**: user management (create courier/admin, role, status), dashboard stats, payments and refunds, and a full audit log of every change.
- **Production hardening**: helmet, strict CORS, Redis-backed rate limits (stricter on auth), Zod validation everywhere, soft deletes, one error envelope, and no secrets in responses or logs.

## Tech stack

| Area | Choice |
|---|---|
| Runtime / language | Node.js ≥ 22.12, TypeScript (strict, no `any`), ES modules |
| HTTP | Express 5 |
| Database | PostgreSQL (Neon) via Prisma 7 + `@prisma/adapter-pg` |
| Validation | Zod 4 (body, query, params) |
| Auth | Better Auth (email/password, Google, `bearer` plugin) |
| Payments | Stripe Checkout Sessions + signed webhooks (test mode) |
| Cache / rate limits | Upstash Redis (REST) |
| Files | Multer (memory) + Cloudinary |
| Email | Resend |
| Security | helmet, cors, express-rate-limit |
| Deploy | Vercel serverless (`api/index.ts`, region `sin1`) |
| Docs | Postman collection (`docs/postman_collection.json`) |

## Architecture

Strict layering: **routes → controllers → services → Prisma**.

```
HTTP request
   │
   ▼
app.ts ── helmet · CORS · Stripe webhook (raw body) · rate limit · auth routes · express.json
   │
   ▼
routes/index.ts ── /api/v1/<module>
   │
   ▼
<module>.route.ts      path + authenticate + authorize(roles) + validateRequest(zod)
   │
   ▼
<module>.controller.ts thin: read validated input → call service → sendResponse()
   │
   ▼
<module>.service.ts    business rules, ownership checks, prisma.$transaction,
   │                   status history + audit log rows, notifications
   ▼
lib/prisma.ts ── PostgreSQL (Neon, pooled)

Errors anywhere → ApiError / ZodError / Prisma error → globalErrorHandler → { success:false, message, errors[] }
Unknown route   → notFound → 404 envelope
```

```
src/
  app.ts                 Express app (exported for Vercel and for server.ts)
  server.ts              local listener
  app/
    config/              env (Zod-validated), currency, frontend link paths
    lib/                 prisma, auth (Better Auth), stripe, redis, cloudinary, email
    middlewares/         authenticate, authorize, validateRequest, rate limiters, upload, errors
    modules/<name>/      route · controller · service · validation · types (+ utils, tests)
      auth user zone hub pricing shipment tracking courier payment admin audit notification health
    utils/               sendResponse, catchAsync, ApiError, pagination, money, ...
    errors/              Zod and Prisma error mappers
api/index.ts             Vercel entry: export default app
prisma/                  schema, migrations, seed (+ seed safety guards)
scripts/                 smoke test, dev-only helpers (never deployed)
docs/                    Postman collection, deployment checklist
```

## Data model (ERD summary)

All domain ids are UUID v7. Money is `Decimal(10,2)` and is returned as a string (`"6.00"`). Mutable entities are soft-deleted (`deletedAt`), and every read excludes deleted rows.

| Table | Purpose | Key relations |
|---|---|---|
| `users` | Every account; `role` CUSTOMER/COURIER/ADMIN, `status` ACTIVE/INACTIVE | 1–1 `courier_profiles`; 1–n shipments (as customer and as courier), payments, notifications |
| `sessions`, `accounts`, `verifications` | Better Auth: sessions (Bearer tokens), credentials/OAuth accounts, one-time values | n–1 `users` |
| `zones` | Service areas (unique `code`) | 1–n hubs, couriers, shipments (origin/destination), pricing rules |
| `hubs` | Sorting hubs, each in one zone | n–1 `zones`; shipments reference origin/destination/current hub |
| `pricing_rules` | Base fee + per-kg fee by service type and (optional) zone pair | n–1 `zones` (origin, destination; null = fallback) |
| `courier_profiles` | Vehicle, operating zone/hub, availability | 1–1 `users`, n–1 `zones`, n–1 `hubs` |
| `shipments` | Sender/receiver, parcel, price snapshot, `status`, `paymentStatus`, proof of delivery | n–1 customer, n–1 courier, zones, hubs; 1–n history, payments; 1–1 pickup, earning |
| `shipment_status_history` | One row per status change (from → to, actor, hub, note) | n–1 `shipments`, n–1 `users` |
| `pickup_requests` | Pickup window and contact (one per shipment) | 1–1 `shipments` |
| `payments` | Stripe Checkout attempts: amount, status, session/intent/refund ids | n–1 `shipments`, n–1 `users` |
| `stripe_events` | Processed webhook event ids (idempotency) | — |
| `courier_earnings` | Earning per delivered shipment | n–1 courier `users`, 1–1 `shipments` |
| `notifications` | In-app notification plus email delivery status | n–1 `users`, n–1 `shipments` |
| `audit_logs` | Who did what to which entity, with before/after (secrets redacted) | n–1 actor `users` (null = system) |

Indexes cover the filtered and sorted columns: status, payment status, customer/courier + date, zones, service type, `createdAt`, `deletedAt`, unique tracking id, Stripe ids, audit entity/action/date, and notification user + read state.

## Shipment status flow

```
                 ┌──────────── CANCELLED (customer/admin, only before PICKED_UP) ───────────┐
                 │                         │                          │                     │
PENDING ──(pay, then customer schedules pickup)──▶ PICKUP_SCHEDULED ──(admin assigns)──▶ COURIER_ASSIGNED
                                              ▲                                            │
                                              └──────────────(admin unassigns)─────────────┤
                                                                                           ▼ courier
 PICKED_UP ─admin─▶ AT_ORIGIN_HUB ─admin─▶ IN_TRANSIT ─admin─▶ AT_DESTINATION_HUB ─admin─▶ OUT_FOR_DELIVERY
                                                                                           │ courier
                                                    ┌──────────────────────────────────────┴───────┐
                                                    ▼                                              ▼
                                                DELIVERED                                   FAILED_DELIVERY
                                                (earning created)          courier retry ──▶ OUT_FOR_DELIVERY (max 3 attempts)
                                                                           admin ──────────▶ RETURNED
```

- A shipment must be **PAID** before it can leave PENDING.
- The one transition table is in `src/app/modules/shipment/shipment.constants.ts`, and every change goes through one service function. In a single transaction it validates the move, the actor's role and ownership, updates the shipment, writes a `shipment_status_history` row and an `audit_logs` row, and creates notifications.
- Courier assignment re-checks the courier's availability and zone inside the transaction, with row locks, so two concurrent requests can't double-assign.

## Roles and permissions

| Capability | CUSTOMER | COURIER | ADMIN |
|---|:-:|:-:|:-:|
| Register / login / Google sign-in / own profile | ✓ | ✓ | ✓ |
| Price estimate, public tracking, list zones & hubs | ✓ (also anonymous) | ✓ | ✓ |
| Create, edit, cancel own shipments; schedule pickup | ✓ (own) | | cancel any |
| Pay (Stripe Checkout), own payments | ✓ (own) | | view all, refund |
| See shipments | own | assigned to them | all |
| Update shipment status | | assigned only (pickup, delivered, failed, retry) | hub legs, returns |
| Upload proof of delivery | | assigned only | |
| Tasks, earnings, availability | | ✓ (own) | |
| Assign / unassign couriers, delete shipments | | | ✓ |
| Zones, hubs, pricing rules (write) | | | ✓ |
| Users (create courier/admin, change role, activate/deactivate) | | | ✓ |
| Dashboard stats, audit logs | | | ✓ |
| Own notifications | ✓ | ✓ | ✓ |

Every rule is enforced by `authenticate` + `authorize(...roles)` and by ownership checks in the services. Other users' resources return **404**, not 403, so their existence isn't revealed. The Postman **RBAC matrix** folder proves this.

## API endpoints

Base URL: `/api/v1`. **64 endpoints**: 58 of our own, plus 6 Better Auth endpoints that are explicitly allowed through. "Auth" means any logged-in role. Every POST, PATCH and PUT is validated with Zod; the webhook is the one exception and is verified by its Stripe signature instead. List endpoints accept `page`, `limit`, `sortBy`, `sortOrder`, `searchTerm` and module filters, and return `meta`.

| # | Method | Path | Role | Purpose |
|--:|---|---|---|---|
| 1 | GET | `/health` | Public | Liveness + database check |
| 2 | POST | `/auth/register` | Public | Email/password sign-up (always CUSTOMER), returns token |
| 3 | POST | `/auth/login` | Public | Login, returns Bearer token |
| 4 | POST | `/auth/logout` | Auth | Revoke the current session |
| 5 | POST | `/auth/refresh-token` | Auth | Rotate the session (new token, old one revoked) |
| 6 | GET | `/auth/google?challenge=` | Public | Start Google sign-in (302 to Google) |
| 7 | GET | `/auth/google/complete` | Public (browser) | Internal landing after Google; 302 to the frontend with a one-time code |
| 8 | POST | `/auth/google/exchange` | Public | Exchange one-time code + verifier for a token |
| 9 | POST | `/auth/change-password` | Auth | Better Auth: change password |
| 10 | GET | `/auth/get-session` | Auth | Better Auth: current session |
| 11 | POST | `/auth/revoke-sessions` | Auth | Better Auth: sign out everywhere |
| 12 | POST | `/auth/revoke-other-sessions` | Auth | Better Auth: sign out other devices |
| 13 | GET | `/auth/ok` | Public | Better Auth: health |
| 14 | GET | `/auth/callback/google` | Public (Google) | Better Auth: Google OAuth redirect URI |
| 15 | GET | `/users/me` | Auth | Own profile (+ courier profile) |
| 16 | PATCH | `/users/me` | Auth | Update own name/phone/address/image (audited) |
| 17 | GET | `/zones` | Public | List zones |
| 18 | GET | `/zones/:id` | Public | Zone detail |
| 19 | POST | `/zones` | Admin | Create zone |
| 20 | PATCH | `/zones/:id` | Admin | Update zone |
| 21 | DELETE | `/zones/:id` | Admin | Soft-delete zone (refused while in use) |
| 22 | GET | `/hubs` | Public | List hubs (filter by zone) |
| 23 | GET | `/hubs/:id` | Public | Hub detail |
| 24 | POST | `/hubs` | Admin | Create hub |
| 25 | PATCH | `/hubs/:id` | Admin | Update hub |
| 26 | DELETE | `/hubs/:id` | Admin | Soft-delete hub (refused while in use) |
| 27 | POST | `/pricing/estimate` | Public | Price quote for zones + service + weight |
| 28 | GET | `/pricing` | Admin | List pricing rules |
| 29 | GET | `/pricing/:id` | Admin | Pricing rule detail |
| 30 | POST | `/pricing` | Admin | Create pricing rule |
| 31 | PATCH | `/pricing/:id` | Admin | Update pricing rule |
| 32 | DELETE | `/pricing/:id` | Admin | Soft-delete pricing rule |
| 33 | POST | `/shipments` | Customer | Create shipment (server-priced, tracking id) |
| 34 | GET | `/shipments` | Auth | List (customer: own, courier: assigned, admin: all) |
| 35 | GET | `/shipments/:id` | Auth | Detail with status history (scoped as above) |
| 36 | PATCH | `/shipments/:id` | Customer | Edit own shipment before pickup (weight/service re-priced; locked after payment) |
| 37 | POST | `/shipments/:id/cancel` | Customer, Admin | Cancel before PICKED_UP (refund if paid) |
| 38 | DELETE | `/shipments/:id` | Admin | Soft-delete (PENDING or terminal only) |
| 39 | POST | `/shipments/:id/pickup` | Customer | Schedule pickup (requires PAID) |
| 40 | POST | `/shipments/:id/assign` | Admin | Assign an available courier in the zone |
| 41 | POST | `/shipments/:id/unassign` | Admin | Unassign courier |
| 42 | PATCH | `/shipments/:id/status` | Courier, Admin | Status change through the state machine |
| 43 | POST | `/shipments/:id/proof` | Courier | Upload proof-of-delivery photo (multipart, ≤ 4 MB) |
| 44 | GET | `/tracking/:trackingId` | Public | Public tracking timeline |
| 45 | GET | `/couriers` | Admin | Couriers for assignment (zone, hub, availability) |
| 46 | GET | `/couriers/me/tasks` | Courier | Own assigned shipments |
| 47 | GET | `/couriers/me/earnings` | Courier | Own earnings + summary |
| 48 | PATCH | `/couriers/me/availability` | Courier | Set availability |
| 49 | GET | `/admin/users` | Admin | List users |
| 50 | POST | `/admin/users` | Admin | Create a courier (with profile) or admin account |
| 51 | PATCH | `/admin/users/:id/role` | Admin | Change role |
| 52 | PATCH | `/admin/users/:id/status` | Admin | Activate / deactivate (revokes sessions) |
| 53 | GET | `/admin/dashboard-stats` | Admin | Totals, status breakdown, revenue, top couriers |
| 54 | GET | `/admin/audit-logs` | Admin | Audit trail (filters: actor, entity, action, dates) |
| 55 | GET | `/admin/payments` | Admin | All payments |
| 56 | POST | `/admin/payments/:id/refund` | Admin | Retry or complete a pending refund |
| 57 | POST | `/payments/initiate` | Customer | Create Payment + Stripe Checkout Session, returns URL |
| 58 | GET | `/payments/verify?session_id=` | Customer, Admin | Success-page check (server-side Stripe lookup) |
| 59 | GET | `/payments/my` | Customer | Own payments |
| 60 | GET | `/payments/:id` | Customer, Admin | Payment detail (own / any) |
| 61 | POST | `/payments/webhook` | Stripe | Signed webhook (raw body, idempotent) |
| 62 | GET | `/notifications/my` | Auth | Own notifications (`unread` filter) |
| 63 | PATCH | `/notifications/read-all` | Auth | Mark all read |
| 64 | PATCH | `/notifications/:id/read` | Auth | Mark one read |

**Responses**

```jsonc
// success (lists add meta)
{ "success": true, "message": "Shipments retrieved successfully", "data": [ ... ],
  "meta": { "page": 1, "limit": 10, "total": 12, "totalPages": 2 } }
// error (validation, auth, not found, conflict, rate limit, ...)
{ "success": false, "message": "Validation failed", "errors": [ { "path": "weightKg", "message": "..." } ] }
```

Status codes: 200/201 success, 400 validation, 401 no/invalid token, 403 wrong role, 404 not found (or not yours), 409 conflict (state machine, duplicates), 413/415 upload, 429 rate limit.

## Environment variables

Copy `.env.example` to `.env` and fill it in. Names and purpose only; never commit real values.

| Variable | Required | Purpose |
|---|:-:|---|
| `NODE_ENV` | | `development` / `production` / `test` (production on Vercel) |
| `PORT` | | Local port (default 5000) |
| `DATABASE_URL` | ✓ | **Pooled** Postgres URL used by the app at runtime |
| `DIRECT_URL` | | **Direct** (non-pooled) URL used by Prisma CLI for migrations |
| `CORS_ORIGINS` | | Comma-separated browser origins allowed to call the API |
| `FRONTEND_URL` | | Frontend origin for email links and the Google sign-in landing page |
| `FRONTEND_SUCCESS_URL` | ✓ | Stripe Checkout success page (frontend) |
| `FRONTEND_CANCEL_URL` | ✓ | Stripe Checkout cancel page (frontend) |
| `BETTER_AUTH_SECRET` | ✓ | ≥ 32-char secret that signs sessions and cookies |
| `BFF_SHARED_SECRET` | production | ≥ 32-char secret shared with the frontend BFF; when `x-bff-secret` matches, `x-client-ip` becomes the rate-limit key (see docs/DEPLOYMENT.md) |
| `BETTER_AUTH_URL` | ✓ | This API's origin (used for Google callbacks and secure cookies) |
| `GOOGLE_CLIENT_ID` | ✓ | Google OAuth client id |
| `GOOGLE_CLIENT_SECRET` | ✓ | Google OAuth client secret |
| `STRIPE_SECRET_KEY` | ✓ | Stripe secret key (test mode: `sk_test_…`) |
| `STRIPE_WEBHOOK_SECRET` | ✓ | Signing secret of the webhook endpoint (`whsec_…`) |
| `UPSTASH_REDIS_REST_URL` | | Upstash Redis REST URL (cache + shared rate limits) |
| `UPSTASH_REDIS_REST_TOKEN` | | Upstash Redis REST token |
| `REDIS_KEY_PREFIX` | | Key prefix per environment (default `carrivo:v1:`) |
| `CLOUDINARY_CLOUD_NAME` | ✓ | Cloudinary account (proof-of-delivery images) |
| `CLOUDINARY_API_KEY` | ✓ | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | ✓ | Cloudinary API secret |
| `RESEND_API_KEY` | | Resend key; without it, notifications are stored but not emailed |
| `EMAIL_FROM` | | Sender, e.g. `Carrivo <noreply@your-domain>` |
| `SEED_DEMO_PASSWORD` | seed only | Password for the seeded demo accounts |
| `SEED_CONFIRM_DB_HOST` | seed in production | Must equal the target DB host when `NODE_ENV=production` |
| `SEED_RESET_DEMO_PASSWORDS` | seed only | `true` re-sets existing demo accounts' passwords |
| `DEV_ALLOW_MARK_PAID` | dev only | Enables `scripts/dev-mark-paid.ts` locally; never set in Vercel |
| `SMOKE_PASSWORD` (+ per-role variants) | smoke only | Demo password for `npm run smoke` |

The app validates its environment at startup and stops with a list of the missing or invalid **names** (it never prints values).

## Local setup

Requires Node.js ≥ 22.12, npm, a Postgres database (a Neon dev branch or a local Postgres), and optionally the Stripe CLI.

```bash
git clone https://github.com/Zarif207/carrivo-backend.git
cd carrivo-backend
npm install                 # also runs prisma generate
cp .env.example .env        # fill in the values (see above)
npm run db:deploy           # apply migrations (or `npm run db:migrate` while changing the schema)
npm run db:seed             # demo data (see below)
npm run dev                 # http://localhost:5000/api/v1/health
```

| Script | What it does |
|---|---|
| `npm run dev` | Start with reload (tsx watch) |
| `npm run build` / `npm start` | Generate Prisma client + compile to `dist/` / run the compiled server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests (node:test) |
| `npm run smoke -- <baseUrl>` | Read-only smoke test against any deployment |
| `npm run db:migrate` / `db:deploy` | Create a migration (dev) / apply migrations |
| `npm run db:seed` / `db:studio` | Seed demo data / open Prisma Studio |
| `npm run dev:mark-paid -- <trackingId>` | **Dev only**: mark a shipment paid without Stripe (refuses in production and on Vercel) |

## Seeding and demo accounts

`npm run db:seed` is idempotent. It upserts 2 zones, 2 hubs and 8 pricing rules, and creates through Better Auth (so passwords are hashed properly) 1 admin, 2 couriers and 2 customers. It also adds 12 sample shipments across the statuses, with pickups, payments and an earning.

| Role | Email | Password |
|---|---|---|
| ADMIN | `admin@carrivo.dev` | `********` (placeholder only) |
| COURIER | `courier1@carrivo.dev`, `courier2@carrivo.dev` | `********` (placeholder only) |
| CUSTOMER | `customer1@carrivo.dev`, `customer2@carrivo.dev` | `********` (placeholder only) |

- All demo accounts use `SEED_DEMO_PASSWORD`. The seed never prints it.
- Accounts that already exist keep their password. `SEED_RESET_DEMO_PASSWORDS=true` re-sets them, revokes their sessions and writes an audit row per account (emails only).
- **Production** (`NODE_ENV=production`): the seed refuses to run unless `SEED_CONFIRM_DB_HOST` equals the database host. The password must be at least 16 characters, mix 3 kinds of characters, and contain no guessable words. See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Testing

**Unit tests:** `npm test` runs about 100 tests covering pricing, the state machine, money, pagination, audit redaction, Stripe helpers, image validation, the email sender, notification content, the Google PKCE helpers and the seed safety guards.

**Smoke test (local or live):**

```bash
SMOKE_PASSWORD='<demo password>' npm run smoke -- http://localhost:5000
SMOKE_PASSWORD='<demo password>' npm run smoke -- https://<your-api>.vercel.app
```

It checks health, public tracking, 404s, a validation error, 401/403 role checks, ownership 404s, and a read-only pass over every list endpoint for all three roles, then prints a PASS/FAIL table (exit code 1 on any failure).

- **It is safe to run against production.** It can only send GET requests plus an allow-list of login, logout and refused probes, and every probe carries an invalid body. It never creates shipments, payments, uploads or emails. Its login sessions are revoked at the end.
- **Rate limit:** each run makes about 60 requests, and the global rate limit is 300 requests per 15 minutes per IP.

**Postman:** import `docs/postman_collection.json` and read the collection description ("How to use").
1. Set `baseUrl` and `demoPassword`.
2. Run the three **Login as …** requests; they save the tokens automatically.
3. Explore the folders, or run **RBAC matrix** in the Runner: 35 requests that must all be refused with the exact status.

## Stripe (test mode) locally

1. Install the [Stripe CLI](https://docs.stripe.com/stripe-cli) and run `stripe login` (test mode).
2. Forward webhooks to the local API with the events we handle:

   ```bash
   stripe listen --forward-to localhost:5000/api/v1/payments/webhook \
     --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired,payment_intent.payment_failed,charge.refunded,refund.failed
   ```

3. Put the printed `whsec_…` into `.env` as `STRIPE_WEBHOOK_SECRET` and restart `npm run dev`.
4. As a customer (Postman):
   1. **Shipments → Create shipment**.
   2. **Payments → Initiate payment**, then open `data.url`.
   3. Pay with card `4242 4242 4242 4242`, any future expiry and any CVC.
5. The CLI shows `checkout.session.completed → 200`. The payment becomes `PAID`, the shipment `paymentStatus` becomes `PAID`, and a PAYMENT_RECEIVED notification is created. `GET /payments/verify?session_id=…` (the success page) reconciles the payment too, in case the webhook was missed.
6. Refunds: cancel a paid shipment before pickup. The CLI then shows `charge.refunded`.

`stripe trigger …` events carry no Carrivo metadata, so the API acknowledges them with 200 and ignores them.

## Authentication

Every protected route takes `Authorization: Bearer <token>`. Tokens come from `POST /api/v1/auth/register`, `POST /api/v1/auth/login` or the Google flow below. Role is never client-settable: new accounts (including Google ones) are `CUSTOMER`.

- Tokens last 7 days.
- `POST /auth/refresh-token` rotates the token and `POST /auth/logout` revokes it.
- Deactivated users can't log in, refresh or use existing tokens.
- Auth routes have a stricter rate limit (20 requests per 15 minutes per IP).

### Google sign-in

A browser flow that ends in the same `{ token, expiresAt, user }` response as login. No token is ever put in a URL or a redirect:

1. The frontend creates a random `codeVerifier`, keeps it (sessionStorage), and navigates the browser to `GET /api/v1/auth/google?challenge=<base64url(SHA-256(codeVerifier)), no padding>`.
2. The user signs in at Google, which redirects to `/api/v1/auth/callback/google`.
3. The API redirects to `FRONTEND_URL/auth/google/callback?code=<one-time code>`, or to `?error=account_exists | account_deactivated | google_cancelled | google_failed`.
4. The frontend calls `POST /api/v1/auth/google/exchange` with `{ "code": "...", "codeVerifier": "..." }` within 60 seconds. The code works once.

`account_exists` means the email already has an account. Google sign-in never links to an existing account; sign in with the password instead.

Frontend paths used in redirects and email links live in `src/app/config/frontendRoutes.ts`.

#### Setup

Google Cloud Console → APIs & Services → Credentials → OAuth client ID (Web application), **Authorized redirect URIs**:

- `http://localhost:5000/api/v1/auth/callback/google`
- `https://<your-api>.vercel.app/api/v1/auth/callback/google`

No Authorized JavaScript origins are needed. Set these locally and in Vercel:
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`;
- `BETTER_AUTH_URL`: exactly the API origin;
- `FRONTEND_URL`: the frontend origin.

While the OAuth app is in **Testing**, only the test users listed in the Console can sign in. Publish it for the live demo (see `docs/DEPLOYMENT.md`).

#### Manual test without a frontend

With the API running (`npm run dev`):

```bash
# 1. Verifier and S256 challenge (base64url, no padding)
VERIFIER=$(openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n')
CHALLENGE=$(printf '%s' "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
echo "Open in a browser: http://localhost:5000/api/v1/auth/google?challenge=$CHALLENGE"
```

2. Open the printed URL and sign in with Google. The browser ends on `http://localhost:3000/auth/google/callback?code=...`. The page doesn't need to exist: copy the `code` value from the address bar.
3. Within 60 seconds, in the same terminal:

```bash
CODE='<paste the code>'
curl -s -X POST http://localhost:5000/api/v1/auth/google/exchange \
  -H 'Content-Type: application/json' \
  -d "{\"code\":\"$CODE\",\"codeVerifier\":\"$VERIFIER\"}"
```

The response holds the Bearer token. Postman: **Auth → Google: exchange code**, with the `googleCode` and `googleCodeVerifier` collection variables. For the live API, replace `http://localhost:5000` with `https://<your-api>.vercel.app`; the browser then ends on your `FRONTEND_URL`.

## Deployment

Vercel serverless: `api/index.ts` exports the Express app, `vercel.json` rewrites every path to it, and functions run in `sin1` (Singapore, next to Neon and Upstash). The full production checklist covers env vars, database, migrations, the seed, Stripe, Google, CORS and post-deploy checks. It is in **[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)**.
