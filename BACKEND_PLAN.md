# Courier & Logistics Platform: Full Backend Plan

How to use: put CLAUDE.md in the repo root. For each phase: `/clear`, start `claude`, press Shift+Tab for Plan Mode, paste the phase prompt, review the plan, approve. After each phase, test in Postman, then commit manually using the chunks Claude suggests.

Footer (already included in every prompt below):
"Show me the plan first and wait for approval. After approval: implement, run npm run build and npx tsc --noEmit, do NOT commit, then list commit-sized chunks with files and conventional commit messages."

Schedule (deadline Nov 15): P1+P2 Nov 5-6, P3+P4 Nov 7-8, P5+P6 Nov 9, P7+P8 Nov 10.

---

## Phase 1: Foundation (Day 1)

```
Phase 1: Foundation. Read CLAUDE.md fully first.

1. Initialize the project: npm, TypeScript strict, Express, the src/app
   layout from CLAUDE.md, tsx or ts-node-dev for dev, and npm scripts
   (dev, build, start, db:migrate, db:seed).
2. Add config/env validation with Zod, plus .env.example and .gitignore.
3. Add utils: sendResponse, catchAsync, ApiError, and the global error
   handler + 404 handler returning the envelope in CLAUDE.md.
4. Set up Prisma with PostgreSQL. Check the current Prisma docs for the
   right setup and generator config. Design the full schema: User,
   CourierProfile, Zone, Hub, PricingRule, Shipment, ShipmentStatusHistory,
   PickupRequest, Payment, CourierEarning, AuditLog, plus the Better Auth
   tables. Use enums, Decimal for money, soft delete (deletedAt),
   relations, and @@index.
5. Add GET /api/v1/health and make the app deployable on Vercel
   (api/index.ts + vercel.json).
6. Do NOT implement auth yet.

Show me the plan and the Prisma schema first. Wait for my approval before
writing code. After approval: implement, run npm run build and
npx tsc --noEmit, do NOT commit, then list commit-sized chunks with files
and conventional commit messages.
```

Done when: `npm run dev` serves `/api/v1/health`, migration applied to Neon/Supabase, first Vercel deploy returns health.

---

## Phase 2: Auth and roles (Day 1-2)

```
Phase 2: Authentication and authorization. Read CLAUDE.md first. Check the
current Better Auth docs (Express integration, Prisma adapter, bearer
plugin) before writing code.

1. Configure Better Auth with the Prisma adapter: email/password, bearer
   plugin, basePath under /api/v1/auth. Add a `role` additional field
   (CUSTOMER/COURIER/ADMIN, default CUSTOMER, input: false so clients
   cannot set it). Mount the handler BEFORE express.json().
2. Write middlewares: authenticate (resolve session from the Bearer token
   via auth.api.getSession, attach user to req) and authorize(...roles).
   Return 401/403 in our error envelope.
3. Endpoints: POST /auth/register (customer only; also support courier
   self-registration creating a CourierProfile pending admin approval if
   you think that is sensible, ask me), POST /auth/login, POST
   /auth/logout, POST /auth/refresh-token (thin wrapper that renews the
   session; explain the design), GET /users/me, PATCH /users/me (Zod,
   whitelisted fields only).
4. Rate limit auth routes (stricter than the global default).
5. Update the seed script: create 1 admin, 2 couriers (with CourierProfile),
   2 customers THROUGH the Better Auth API so passwords hash correctly.
   Print the demo credentials in the seed output.
6. Do not set up Google login yet (Phase 7).

Show me the plan first and wait for approval. After approval: implement,
run npm run build and npx tsc --noEmit, do NOT commit, then list
commit-sized chunks with files and conventional commit messages.
```

Done when: register, login, `/users/me` with Bearer token works in Postman, a customer token gets 403 on an admin-only test route, wrong token gets 401.

---

## Phase 3: Core resources and shipments (Day 2-3)

```
Phase 3: Core resources. Read CLAUDE.md first.

Build modules (route/controller/service/validation) for:
1. Zones and Hubs: admin CRUD with soft delete; public GET list.
2. PricingRule: admin CRUD; POST /pricing/estimate (weight, service type,
   origin/destination zone) returns a price breakdown. Put the calculation
   in a pure, unit-testable function.
3. Shipment: POST /shipments (customer): validates zones/hubs, generates a
   unique readable trackingId, calculates price server-side (never trust a
   client price), creates the shipment with status PENDING, a
   ShipmentStatusHistory row, and an AuditLog row in one transaction.
   GET /shipments (role-scoped: customer sees own, courier sees assigned,
   admin sees all) with page, limit, sortBy, sortOrder, searchTerm (trackingId,
   receiver name/phone), filters (status, date range, serviceType).
   GET /shipments/:id with ownership checks. PATCH /shipments/:id (customer,
   only while PENDING). POST /shipments/:id/cancel. DELETE /shipments/:id
   (admin soft delete).
4. Public GET /tracking/:trackingId returning the status timeline with no
   private data.
5. Add DB indexes for the list filters. Use select to avoid over-fetching.

Show me the plan first and wait for approval. After approval: implement,
run npm run build and npx tsc --noEmit, do NOT commit, then list
commit-sized chunks with files and conventional commit messages.
```

Done when: a customer creates a shipment, lists it with filters and pagination, public tracking shows the timeline, a different customer gets 403/404 on it.

---

## Phase 4: Workflow engine (Day 3-4)

```
Phase 4: Shipment workflow. Read CLAUDE.md first.

1. Implement the state machine: one allowedTransitions map plus ONE service
   function changeShipmentStatus(shipmentId, toStatus, actor, note).
   It validates the transition and actor role (couriers can only move their
   own assigned shipments through courier-owned statuses; admin can move
   hub statuses), then in one prisma.$transaction updates the shipment,
   inserts ShipmentStatusHistory, and inserts AuditLog.
2. PickupRequest: customer schedules a pickup time/address for a shipment
   (POST /shipments/:id/pickup); moves status to PICKUP_SCHEDULED.
3. Assignment: POST /shipments/:id/assign (admin). In a transaction,
   lock/re-check that the courier is active, available, and in the right
   zone and that the shipment is unassigned, so concurrent requests cannot
   double-assign. Show me how you prevent the race (row lock or conditional
   update).
4. PATCH /shipments/:id/status for courier/admin.
5. Failed delivery (reason required, attempt count) and return-to-sender
   flow: FAILED_DELIVERY -> OUT_FOR_DELIVERY retry or RETURNED.
6. Courier endpoints: GET /couriers/me/tasks, GET /couriers/me/earnings,
   PATCH /couriers/me/availability. Create a CourierEarning row when a
   shipment reaches DELIVERED (in the same transaction).
7. Payment gate: a shipment must have paymentStatus PAID before moving past
   PENDING. Implement the check now; it will be exercised after Phase 6.
   For testing before Phase 6, tell me how to flip the flag safely in dev
   only.

Show me the plan first and wait for approval. After approval: implement,
run npm run build and npx tsc --noEmit, do NOT commit, then list
commit-sized chunks with files and conventional commit messages.
```

Done when: full happy path PENDING to DELIVERED works across customer/courier/admin tokens, illegal transitions return 400, a courier can't touch another courier's shipment, two parallel assign requests result in one success.

---

## Phase 5: Admin, caching, hardening (Day 4-5)

```
Phase 5: Admin and hardening. Read CLAUDE.md first.

1. Admin: GET /admin/users (pagination, search, role filter),
   PATCH /admin/users/:id/role, PATCH /admin/users/:id/status (activate or
   deactivate), GET /admin/dashboard-stats (totals by status, revenue,
   deliveries per day for 30 days, top couriers, failed-delivery rate),
   GET /admin/audit-logs (filter by actor, action, entity, date range).
   Every admin mutation writes an AuditLog row.
2. Redis (Upstash, @upstash/redis REST client): cache dashboard stats and
   hub/zone/pricing lists with sensible TTLs and invalidate on writes.
   Cache public tracking briefly. The app must still work if Redis is down
   (fail open, log a warning).
3. Move rate limiting to Redis-backed storage if it works on serverless;
   otherwise explain the tradeoff and keep the in-memory limiter.
4. Add helmet, strict CORS from env (allow local frontend and the future
   Vercel frontend URL), body size limits, and a consistent 404 and error
   path. Review that no response leaks password hashes, tokens, or
   internal fields.
5. Add missing indexes based on the queries we actually wrote.

Show me the plan first and wait for approval. After approval: implement,
run npm run build and npx tsc --noEmit, do NOT commit, then list
commit-sized chunks with files and conventional commit messages.
```

Done when: stats endpoint is fast on the second call, role change shows up in audit logs, non-admins get 403 on every `/admin/*` route.

---

## Phase 6: Stripe payments (Day 5)

```
Phase 6: Stripe payments. Read CLAUDE.md first and check the current
Stripe Node SDK and Checkout docs before coding.

1. POST /payments/initiate (customer, own shipment, only if unpaid): create
   a Payment row (PENDING, amount from the shipment price in the smallest
   currency unit), create a Stripe Checkout Session with shipmentId and
   paymentId in metadata, success_url and cancel_url from env, return the
   session URL.
2. POST /payments/webhook: raw body (mount express.raw for this route
   BEFORE express.json), verify the Stripe signature, handle
   checkout.session.completed (mark Payment PAID, set shipment paymentStatus
   PAID, write AuditLog, all in one transaction) and checkout.session.expired
   or payment_intent.payment_failed (mark FAILED). Make it idempotent:
   ignore events for already-processed payments.
3. GET /payments/:id (owner or admin) and GET /payments/my (customer,
   paginated).
4. Never mark a payment as paid from any client-triggered endpoint.
5. Tell me exactly how to test locally with the Stripe CLI
   (stripe listen --forward-to ...) and which env vars to set, including on
   Vercel.

Show me the plan first and wait for approval. After approval: implement,
run npm run build and npx tsc --noEmit, do NOT commit, then list
commit-sized chunks with files and conventional commit messages.
```

Done when: initiate returns a Checkout URL, paying with test card `4242 4242 4242 4242` flips the payment to PAID via webhook, replaying the webhook changes nothing, and the Phase 4 payment gate now passes for real.

---

## Phase 7: Google login, uploads, notifications (Day 6)

```
Phase 7: Extras. Read CLAUDE.md first and check the current Better Auth
Google provider docs.

1. Add Google social login to Better Auth. New Google users default to
   CUSTOMER. Tell me exactly which redirect URIs to register in Google
   Cloud Console for local and for the Vercel production URL, and which
   env vars to set.
2. Proof of delivery: Multer (memory storage) + Cloudinary upload.
   POST /shipments/:id/proof (assigned courier only, only when OUT_FOR_DELIVERY
   or DELIVERED) with file type and size validation; store the URL on the
   shipment. Make sure it works on Vercel serverless (no disk writes).
3. Notifications: send an email (Nodemailer or Resend, ask me which) on
   shipment created, courier assigned, out for delivery, delivered, and
   payment received. Fire-and-forget safely: email failure must never fail
   the API request. Store a Notification row and add GET /notifications/my
   and PATCH /notifications/:id/read.

Show me the plan first and wait for approval. After approval: implement,
run npm run build and npx tsc --noEmit, do NOT commit, then list
commit-sized chunks with files and conventional commit messages.
```

Done when: Google login returns a usable token, a proof image uploads and the URL shows on the shipment, an email arrives on assignment.

---

## Phase 8: Docs, tests, deploy, submission (Day 7)

```
Phase 8: Documentation, testing, deployment. Read CLAUDE.md first.

1. Generate a complete Postman collection in /docs/postman_collection.json:
   folders per module, environment variables (baseUrl, tokens per role),
   example requests AND example success/error responses, and test scripts
   that save tokens/ids automatically. Include a "403 role matrix" folder
   that proves each role is blocked from the other roles' endpoints.
2. Write a smoke-test script (or documented manual checklist) covering:
   auth for all 3 roles, create shipment, pay, assign, full delivery,
   validation error, 401, 403, 404.
3. Audit every endpoint against CLAUDE.md: envelope shape, Zod validation,
   soft-delete filters, audit logs, indexes. List anything missing and fix
   it. Count the endpoints and confirm there are 20+ meaningful ones.
4. Write README.md: overview, architecture diagram (text), ERD summary,
   status flow, endpoint table, env vars, run instructions, demo
   credentials placeholder, submission block in the format the assignment
   requires.
5. Vercel production checklist: env vars, pooled vs direct DB URLs,
   prisma generate on build, Stripe webhook endpoint registration, CORS
   origins, Google redirect URI. Tell me how to run the migration and seed
   against production safely.

Show me the plan first and wait for approval. After approval: implement,
run npm run build and npx tsc --noEmit, do NOT commit, then list
commit-sized chunks with files and conventional commit messages.
```

Done when: the live URL passes the smoke checklist for all three roles and Stripe, the Postman docs are published, and your video script has a working demo for each point in the assignment's video guide.

---

## Endpoint map (about 40, so the 20+ minimum is safe)

| Area | Endpoints |
|---|---|
| Auth | register, login, logout, refresh-token, Google |
| Users | GET/PATCH /users/me |
| Zones/Hubs/Pricing | CRUD (admin) + GET lists + POST /pricing/estimate |
| Shipments | create, list, get, update, cancel, soft-delete, pickup, assign, status, proof |
| Tracking | GET /tracking/:trackingId (public) |
| Courier | tasks, earnings, availability |
| Payments | initiate, webhook, GET /payments/:id, GET /payments/my |
| Notifications | GET my, PATCH read |
| Admin | users, role, status, dashboard-stats, audit-logs |
