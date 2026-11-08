# Courier & Logistics Platform: Backend

REST API for a courier/logistics platform. Customers create and pay for shipments, couriers pick up and deliver them, admins manage hubs, zones, pricing, users, and reports. Backend-only assignment (Programming Hero B7A6). A Next.js frontend (B7A7) will consume this API later, so keep responses stable and typed.

## Stack
- Node.js, TypeScript (strict, no `any`), Express
- PostgreSQL + Prisma (hosted on Neon/Supabase)
- Zod for all request validation
- Better Auth: email/password + Google social login, `bearer` plugin so protected routes accept `Authorization: Bearer <token>`
- Stripe (test mode) via Checkout Sessions + webhook
- Redis (Upstash) for caching and rate limiting. Prefer `@upstash/redis` (REST) because we run serverless.
- Cloudinary + Multer for proof-of-delivery images
- Nodemailer or Resend for email notifications
- helmet, cors, express-rate-limit
- Deploy: Vercel serverless functions (`api/index.ts` exports the Express app, `vercel.json` rewrites all routes to it)
- Package manager: npm
- Docs: Postman collection (kept in `/docs/postman_collection.json`)

IMPORTANT: Better Auth, Prisma, Stripe, and Vercel setups change between versions. Check the current official docs before writing setup code. Do not guess APIs from memory.

## Architecture (strict layering)
`routes → controllers → services → prisma`
- Routes: path + middleware (auth, role, validate) + controller only.
- Controllers: thin. Parse input, call a service, send the response via the response helper. No Prisma calls here.
- Services: all business logic and all Prisma access.
- `src/app/` layout: `config/`, `lib/` (prisma, auth, stripe, redis, cloudinary), `middlewares/`, `modules/<name>/{route,controller,service,validation,types}.ts`, `utils/` (sendResponse, catchAsync, ApiError), `errors/`.
- Modules: auth, user, shipment, tracking, pricing, hub, zone, courier, payment, admin, audit.

## API conventions
- All routes under `/api/v1`.
- Success: `{ "success": true, "message": "...", "data": {}, "meta"?: { page, limit, total, totalPages } }`
- Error: `{ "success": false, "message": "...", "errors": [] }`
- One global error handler maps Zod, Prisma (P2002, P2025), ApiError, and auth errors to this shape. Include a 404 handler for unknown routes.
- Validate every POST/PATCH/PUT with Zod (body, params, query as needed).
- List endpoints support `page`, `limit`, `sortBy`, `sortOrder`, `searchTerm`, and relevant filters.
- Soft delete only (`deletedAt`). Every read query excludes soft-deleted rows.
- Use Prisma `select`/`include` deliberately. Never return password hashes, tokens, or secrets.

## Roles (exactly 4)
- `CUSTOMER`: creates/cancels own shipments, pays, tracks, views own history.
- `COURIER`: sees assigned tasks, updates status of assigned shipments only, views own earnings, sets availability.
- `ADMIN`: everything, including hubs, zones, pricing rules, user management, assignment, stats, audit logs.
- `ADMIN_VIEWER`: read-only admin. Allowed on every admin GET route (use `authorize(...STAFF_ROLES)` from `config/roles.ts` for admin reads); every POST/PUT/PATCH/DELETE is refused by the central rule in `middlewares/readOnly.ts` (only logout and refresh-token pass). Never on customer/courier-only routes. Created only by the seed; never assignable via the API (`ASSIGNABLE_ROLES`).
Role is never client-settable on signup (Better Auth additional field with `input: false`, plus a `user.create.before` hook forcing `CUSTOMER`). Enforce with `authenticate` + `authorize(...roles)` middleware, plus ownership checks in services. Keep module routers flat (no nested routers) so `readOnly.test.ts` can walk every route.

## US platform conventions
- USD money, weights in pounds (`weightLb`, `perLbFee`), US addresses (`street, City, ST 12345`, `usAddressSchema`), US phones (`phoneSchema`), business dates in America/New_York (`utils/timezone.ts`).
- Demo data: fictional names, 555-0100 to 555-0199 phone numbers, no real people or businesses.

## Shipment state machine
Statuses: PENDING, PICKUP_SCHEDULED, COURIER_ASSIGNED, PICKED_UP, AT_ORIGIN_HUB, IN_TRANSIT, AT_DESTINATION_HUB, OUT_FOR_DELIVERY, DELIVERED, FAILED_DELIVERY, RETURNED, CANCELLED.
- Keep ONE `allowedTransitions` map in `shipment/shipment.constants.ts`; every status change goes through ONE service function.
- Each status change, in a single `prisma.$transaction`: validate transition and actor role, update the shipment, insert a `ShipmentStatusHistory` row, insert an `AuditLog` row.
- CANCELLED is allowed only before PICKED_UP. A shipment must be PAID before it can move past PENDING.
- Courier assignment runs in a transaction that re-checks the courier is available and in the correct zone, so a courier can't be double-assigned under concurrent requests.

## Payments (Stripe)
- `POST /payments/initiate` creates a Payment row (PENDING) and a Stripe Checkout Session with `shipmentId` and `paymentId` in metadata; returns the session URL.
- `POST /payments/webhook` verifies the Stripe signature. It MUST receive the raw body: mount `express.raw({ type: 'application/json' })` for this route BEFORE `express.json()`.
- Webhook handling is idempotent (ignore events for already-PAID payments). On `checkout.session.completed`, mark Payment PAID and the shipment payment status, in a transaction, and write an audit log.
- Never mark a payment paid from a client call. Only the verified webhook (or a server-side session retrieval) may do that.
- Handle success and cancel redirect URLs via env vars (frontend URLs).

## Database rules
- Add `@@index` on frequently filtered columns (status, customerId, courierId, trackingId unique, createdAt, deletedAt).
- Use enums for roles, statuses, payment status, vehicle type, service type.
- Seed script creates: 1 admin, 1 admin viewer, 2 couriers, 2 customers (create users via the Better Auth API so passwords hash correctly), hubs, zones, pricing rules, and sample shipments across statuses. Demo credentials live in README, not in code comments.

## Security
- helmet, strict CORS (allowed origins from env), rate limiting (stricter on auth routes).
- Never commit `.env`; keep `.env.example` current. Never log secrets or tokens.

## Git
- NEVER run `git add`, `git commit`, `git push`, or any command that changes git history or the remote. The user commits and pushes manually.
- The assignment needs 20+ meaningful commits, so at the end of each task or phase, list the work as logical commit-sized chunks. For each chunk give the files involved and a conventional commit message (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`), so the user can commit them one by one.
- Keep changes small and grouped by module so they split cleanly into separate commits.
- Read-only git commands (`git status`, `git diff`, `git log`) are fine.

## Workflow rules for Claude
- For each phase: propose a short plan first, wait for approval, then implement.
- After implementing, run `npm run build` and `npx tsc --noEmit`; fix errors, then give me the suggested commit list (do not commit).
- When adding an endpoint, also add it to the Postman collection with an example request and response.
- Ask me when a requirement is ambiguous instead of inventing business rules.
