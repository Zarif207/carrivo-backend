# Carrivo API reference

Request and response shapes for every endpoint. Base URL: `https://carrivo-backend.vercel.app/api/v1` (local: `http://localhost:5000/api/v1`). The [Postman collection](postman_collection.json) has an example request and response for each one.

- [Conventions](#conventions)
- [Health](#health)
- [Auth](#auth)
- [Users](#users)
- [Zones and hubs](#zones-and-hubs)
- [Pricing](#pricing)
- [Shipments](#shipments)
- [Tracking](#tracking)
- [Couriers](#couriers)
- [Admin](#admin)
- [Payments](#payments)
- [Notifications](#notifications)
- [Read-only accounts (ADMIN_VIEWER)](#read-only-accounts-admin_viewer)
- [Security limits](#security-limits)

## Conventions

- **Auth:** `Authorization: Bearer <token>` on every protected route. Tokens come from login, register or the Google exchange and last 7 days.
- **Success envelope:** `{ "success": true, "message": "...", "data": ..., "meta"?: { "page", "limit", "total", "totalPages" } }`; `meta` only on lists.
- **Error envelope:** `{ "success": false, "message": "...", "errors": [{ "path": "body.email", "message": "..." }] }`.
- **Validation:** Zod on body, query and params. Bodies are strict: unknown keys are rejected.
- **Lists:** `page` (default 1), `limit` (default 10, max 100), `sortOrder` (`asc` | `desc`, default `desc`), a per-endpoint `sortBy` whitelist, `searchTerm` (1 to 100 characters) where listed, and filters. Boolean filters are `"true"` / `"false"`. Date filters (`fromDate`, `toDate`) accept `YYYY-MM-DD` (a whole day in America/New_York) or an ISO date-time with offset.
- **US formats:** money in US dollars as 2-decimal strings in responses and numbers in requests; weights in pounds (`> 0`, `≤ 2000`, 2 decimals); addresses as `street, City, ST 12345` (ZIP or ZIP+4, valid state code); US phone numbers.
- **Ownership:** another user's record answers **404**, not 403.

Shapes below are written as TypeScript-like objects; `?` means optional.

## Health

### `GET /health`
Public. Liveness and a database check.

```json
{ "status": "ok", "environment": "production", "uptime": 42, "timestamp": "2026-11-10T14:00:00.000Z", "database": "up" }
```

`GET /` (outside `/api/v1`) also answers 200 with `{ "version": "v1", "docs": "/api/v1/health" }`.

## Auth

### `POST /auth/register`
Public, auth rate limit. Always creates a `CUSTOMER`; a `role` field is rejected.
- **Body:** `{ name (2-100), email, password (8-128), phone? }`
- **201:** `{ token, expiresAt, user }`. **409** when the email exists.

### `POST /auth/login`
Public, auth rate limit.
- **Body:** `{ email, password }`
- **200:** `{ token, expiresAt, user }`. **401** wrong email or password, **403** account deactivated, **429** too many failed attempts.

### `POST /auth/logout`
Any role. No body. **200** with `data: null`; the token stops working at once.

### `POST /auth/refresh-token`
Any role. No body. Rotates a still-valid token.
- **200:** `{ token, expiresAt }`. The token you sent is revoked.

### `GET /auth/google?challenge=<base64url(SHA-256(codeVerifier))>`
Public, browser navigation only. **302** to Google. The challenge is 43 characters, no padding.

### `GET /auth/google/complete`
Browser only (Google lands here through Better Auth). **302** to `FRONTEND_URL/auth/google/callback?code=<one-time code>`, or `?error=account_exists | account_deactivated | google_cancelled | google_failed`.

### `POST /auth/google/exchange`
Public, auth rate limit, server to server.
- **Body:** `{ code, codeVerifier (43-128, [A-Za-z0-9-._~]) }` within 60 seconds of the redirect
- **200:** `{ token, expiresAt, user }` (new users are `CUSTOMER`). The code works once; **400** invalid or expired code, **403** deactivated.

### Better Auth endpoints (allow-listed)
These answer in Better Auth's own shape, not the envelope.

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/auth/change-password` | Body `{ currentPassword, newPassword (8-128), revokeOtherSessions? }` → `{ token, user: { id, email, name } }`. Failed attempts count toward the auth limit. Not for `ADMIN_VIEWER` |
| GET | `/auth/get-session` | The current session and user |
| POST | `/auth/revoke-sessions` | Sign out everywhere. Not for `ADMIN_VIEWER` |
| POST | `/auth/revoke-other-sessions` | Sign out other devices. Not for `ADMIN_VIEWER` |
| GET | `/auth/ok` | Better Auth health |
| GET | `/auth/callback/google` | Google's redirect URI |

Any other `/auth/*` path answers 404 on purpose (for example `list-sessions`, which would return raw tokens).

## Users

### `GET /users/me`
Any role. **200:** `UserProfile { id, name, email, role, status, phone, address, image, createdAt, courierProfile }` (`courierProfile` is null unless the user is a courier).

### `PATCH /users/me`
Any role except `ADMIN_VIEWER`.
- **Body (at least one):** `{ name?, phone? | null, address? | null, image? (URL) | null }`
- **200:** `UserProfile`

## Zones and hubs

### `GET /zones`
Public, cached 120 s. Query: `searchTerm` (name, code), `sortBy` `name | code | createdAt`, `isActive` `true` (default) `| false | all`.
**200:** `Zone[] { id, name, code, description, isActive, createdAt, updatedAt }` + meta.

### `GET /zones/:id`
Public. **200:** `Zone`.

### `POST /zones` (Admin)
- **Body:** `{ name (2-100), code (^[A-Z0-9-]{2,20}$, upper-cased), description? (≤ 500) | null, isActive? }`
- **201:** `Zone`. **409** duplicate code.

### `PATCH /zones/:id` (Admin)
Any field of the create body (at least one). **200:** `Zone`.

### `DELETE /zones/:id` (Admin)
Soft delete. **200:** the deleted zone. **409** while hubs or couriers use it (listed in `errors`).

### `GET /hubs`
Public, cached 120 s. Query: `zoneId`, `city` (exact, case-insensitive), `searchTerm` (name, code, city), `sortBy` `name | code | city | createdAt`, `isActive`.
**200:** `Hub[] { id, name, code, address, city, phone, isActive, zone: { id, name, code } }` + meta.

### `GET /hubs/:id`
Public. **200:** `Hub`.

### `POST /hubs` (Admin)
- **Body:** `{ name (2-100), code (^[A-Z0-9-]{2,30}$), address (US address), city (2-100), phone? | null, zoneId (an active zone), isActive? }`
- **201:** `Hub`.

### `PATCH /hubs/:id` (Admin)
Any field (at least one). **200:** `Hub`. **409** on a zone change while the hub is in use.

### `DELETE /hubs/:id` (Admin)
Soft delete. **409** while in use.

## Pricing

`price = baseFee + ceil(max(0, weightLb − baseWeightLb)) × perLbFee`. A route rule (both zones set) wins over the service's default rule (both zones null).

The seeded network (8 zones, 16 hubs, 54 rules, defined in [`prisma/seed.network.ts`](../prisma/seed.network.ts)) prices by distance tier, using only that lookup:

| Tier | Which routes | Rule | Standard | Express | Same Day |
| --- | --- | --- | --- | --- | --- |
| Metro | Origin and destination in the same zone | One route rule per zone | $6.50 + $0.60/lb | $11.00 + $1.00/lb | $18.00 + $1.50/lb |
| Regional | Metros under ~750 miles apart: LA–SF, SF–Seattle, NYC–Chicago, NYC–Atlanta, Chicago–Atlanta, Atlanta–Miami, Atlanta–Houston (both directions) | One route rule per direction | $9.00 + $0.90/lb | $17.00 + $1.75/lb | not offered |
| National | Every other pair of zones | The service's default rule | $12.00 + $1.25/lb | $24.00 + $2.50/lb | not offered (422) |

Every rule includes the first 2 lb in the base fee; the per-pound fee applies to each started pound above that. Weight limits: Standard 70 lb, Express 50 lb, Same Day 20 lb.

### `POST /pricing/estimate`
Public, cached 120 s.
- **Body:** `{ weightLb, serviceType (STANDARD | EXPRESS | SAME_DAY), originZoneId, destinationZoneId }`
- **200:** `{ currency, weightLb, baseWeightLb, chargeableExtraLb, baseFee, perLbFee, weightCharge, total, serviceType }`. **422** when no rule covers the route or the weight is over the rule's maximum.

### `GET /pricing`, `GET /pricing/:id` (Staff)
Query: `serviceType`, `originZoneId`, `destinationZoneId`, `isActive`, `searchTerm` (name), `sortBy` `name | serviceType | baseFee | perLbFee | createdAt`.
**200:** `PricingRule[] { id, name, serviceType, originZone, destinationZone, baseFee, baseWeightLb, perLbFee, maxWeightLb, isActive, createdAt, updatedAt }` + meta, or one rule.

### `POST /pricing` (Admin)
- **Body:** `{ name (2-100), serviceType, originZoneId? | null, destinationZoneId? | null (both or neither), baseFee, baseWeightLb? (default 1), perLbFee, maxWeightLb? | null (≥ baseWeightLb), isActive? (default true) }`
- **201:** `PricingRule`. **409** when an active rule already exists for that service and route.

### `PATCH /pricing/:id`, `DELETE /pricing/:id` (Admin)
Partial update (at least one field) → `PricingRule`; delete is a soft delete.

## Shipments

Every shipment route needs a session. Customers see their own shipments, couriers the ones assigned to them, staff all of them.

### `POST /shipments` (Customer)
- **Body:** `{ senderName, senderPhone, pickupAddress, receiverName, receiverPhone, receiverEmail? | null, deliveryAddress, description? (≤ 500) | null, declaredValue? | null, isFragile?, weightLb, serviceType, originZoneId, originHubId, destinationZoneId, destinationHubId }`
- **201:** `ShipmentDetail` with status `PENDING`, payment status `UNPAID`, a new `trackingId` (`CRV-YYMMDD-XXXXXX`) and the server's `price` and `priceBreakdown`. **422** when it can't be priced.

### `GET /shipments`
Any role (scoped). Query: `searchTerm` (tracking id, receiver name or phone), `status`, `serviceType`, `paymentStatus`, `fromDate`, `toDate`, `customerId` and `courierId` (staff), `sortBy` `createdAt | updatedAt | price | weightLb | status | trackingId`.
**200:** `ShipmentListItem[]` + meta.

### `GET /shipments/:id`
Any role (scoped). **200:** `ShipmentDetail` (with `statusHistory`, `pickupRequest`, `priceBreakdown`, proof-of-delivery fields, zones, hubs, customer and courier). **404** when it isn't yours.

### `PATCH /shipments/:id` (Customer)
Only while `PENDING`. Any editable field of the create body (at least one). Weight or service changes re-price it; both are locked once paid or while a checkout is open (**409**).

### `POST /shipments/:id/cancel` (Customer, Admin)
Before `PICKED_UP`. **Body (optional):** `{ reason? (3-500) }`. **200:** `ShipmentDetail` (`CANCELLED`). A paid shipment is refunded through Stripe.

### `DELETE /shipments/:id` (Admin)
Soft delete, only `PENDING` or terminal shipments. **200:** `{ id, trackingId, deletedAt }`; **409** otherwise.

### `POST /shipments/:id/pickup` (Customer)
The shipment must be paid (**409** otherwise).
- **Body:** `{ windowStart, windowEnd (ISO date-times with offset), pickupAddress?, contactName?, contactPhone?, notes? (≤ 500) }`. The window must start in the future, within 30 days, and last at most 12 hours.
- **200:** `ShipmentDetail` (`PICKUP_SCHEDULED`, with `pickupRequest`).

### `POST /shipments/:id/assign` (Admin)
- **Body:** `{ courierId (the courier's user id), note? (3-500) }`
- **200:** `ShipmentDetail` (`COURIER_ASSIGNED`). **400** courier outside the origin zone, **409** courier unavailable or assigned concurrently.

### `POST /shipments/:id/unassign` (Admin)
**Body (optional):** `{ note? }`. **200:** `ShipmentDetail` (back to `PICKUP_SCHEDULED`).

### `PATCH /shipments/:id/status` (Courier, Admin)
- **Body:** `{ status, note? (3-500), hubId? }`
  - Courier (assigned): `PICKED_UP`, `DELIVERED`, `FAILED_DELIVERY` (note required), `OUT_FOR_DELIVERY` (retry, fewer than 3 attempts).
  - Admin: `AT_ORIGIN_HUB`, `IN_TRANSIT`, `AT_DESTINATION_HUB`, `OUT_FOR_DELIVERY`, `RETURNED`. `hubId` only for the two hub statuses.
- **200:** `ShipmentDetail`. **400** illegal move (lists the allowed next statuses), **403** right move, wrong role, **409** changed concurrently.

### `POST /shipments/:id/proof` (Courier, assigned)
`multipart/form-data` with exactly one file in field `image`: JPEG, PNG or WebP whose bytes match the type, up to 4 MB. Only while `OUT_FOR_DELIVERY` or `DELIVERED`.
**200:** `ShipmentDetail` with `proofOfDeliveryUrl`. Re-uploading replaces the image. **400** wrong type, **409** wrong status, **413** too large, **415** not multipart.

## Tracking

### `GET /tracking/:trackingId`
Public, cached 15 s. **200:** `{ trackingId, status, serviceType, origin: { city }, destination: { city }, createdAt, estimatedDeliveryAt, deliveredAt, timeline: [{ status, city, at }] }`. No names, phone numbers or addresses. **400** bad format, **404** unknown.

## Couriers

### `GET /couriers` (Staff)
Query: `zoneId`, `hubId`, `available`, `searchTerm` (name, email, phone), `sortBy` `name | createdAt`.
**200:** `CourierListItem[] { id, name, email, phone, courierProfile, activeTaskCount }` + meta.

### `GET /couriers/me/tasks` (Courier)
Query: `status` (omit = active: not delivered, returned or cancelled), `searchTerm`, `sortBy` `createdAt | updatedAt | status`.
**200:** `CourierTask[]` + meta (list fields plus sender phone, fragile flag, description, attempts, failure reason, proof fields, current hub and pickup request).

### `GET /couriers/me/earnings` (Courier)
Query: `status` (`PENDING | PAID`), `fromDate`, `toDate`, `sortBy` `createdAt | amount`.
**200:** `{ summary: { totalEarned, pending, paidOut, deliveries }, earnings: Earning[] }` + meta.

### `PATCH /couriers/me/availability` (Courier)
**Body:** `{ isAvailable: boolean }`. **200:** `CourierProfile`. Unavailable couriers keep their tasks but get no new ones.

## Courier applications

A `CUSTOMER` applies to become a `COURIER`; an `ADMIN` approves or rejects. No driver licence number, SSN or other government ID is collected: the body is strict, so such fields are refused (**400**).

`CourierApplication { id, status (PENDING | APPROVED | REJECTED | CANCELLED), phone, vehicleType (BICYCLE | MOTORCYCLE | CAR | VAN | TRUCK), vehiclePlate | null, availability (WEEKDAYS | WEEKENDS | FULL_TIME), experience | null, about | null, reviewNote | null, reviewedAt | null, createdAt, updatedAt, preferredZone { id, name, code } | null }`. The staff view (`AdminCourierApplication`) adds `user { id, name, email, phone, role, status }` and `reviewedBy { id, name } | null`; the applicant never sees who reviewed.

**Rules.** One `PENDING` application per user (also a partial unique index, so two simultaneous submits give one **201** and one **409**). After a `REJECTED` one the user may apply again 7 days after `reviewedAt` (`REAPPLY_COOLDOWN_DAYS`); a `CANCELLED` one starts no wait. Decisions are final: approve, reject and cancel need `PENDING`, otherwise **409** with `errors: [{ path: "status", message: "<current status>" }]`.

### `POST /courier-applications` (Customer)
- **Body:** `{ phone (US), vehicleType, availability, preferredZoneId? | null, vehiclePlate? | null (2-20, letters, digits, spaces, dashes; stored upper-case), experience? (≤ 500), about? (≤ 1000) }`.
- **201:** `CourierApplication` (`PENDING`). Staff get a `COURIER_APPLICATION_SUBMITTED` notice.
- **403** staff account (`ADMIN`: "Staff accounts can't apply…"; `ADMIN_VIEWER`: "This account is read-only"), **409** `COURIER` ("You are already a courier"); both before the body is validated. **409** a pending application exists, or the rejection wait is running: `"Your last application was not approved. You can apply again on Nov 18, 2026."` with `errors: [{ path: "canReapplyAt", message: "<ISO date-time>" }]`. **400** unknown or inactive `preferredZoneId`. Rate limit: 10 submits and cancels per hour per user.

### `GET /courier-applications/my` (Customer, Courier)
**200:** `{ latest: CourierApplication | null, history: CourierApplication[] (newest first, up to 20, latest included), canApply, canReapplyAt: ISO | null, blockedReason: string | null, cooldownDays: 7 }`. Each item carries the admin's `reviewNote`.

### `PATCH /courier-applications/my/:id/cancel` (Customer)
No body. **200:** `CourierApplication` (`CANCELLED`). **404** not yours (never confirmed), **409** not pending.

### `GET /admin/courier-applications` (Staff)
Query: `status`, `zoneId` (preferred zone), `vehicleType`, `searchTerm` (applicant name, email, application phone), `sortBy` `createdAt | updatedAt | status` (default `createdAt`, `sortOrder` default `desc`: newest first), `page`, `limit`. **200:** `AdminCourierApplication[]` + meta.

### `GET /admin/courier-applications/:id` (Staff)
**200:** `AdminCourierApplication`. **404** unknown id.

### `PATCH /admin/courier-applications/:id/approve` (Admin)
- **Body (optional):** `{ zoneId?, hubId? | null }`. The courier's zone is `zoneId`, else the application's preferred zone (**400** `body.zoneId` when neither exists); the hub is optional and must be active and in that zone.
- One transaction, the same path as `PATCH /admin/users/:id/role` to `COURIER`: locks the active admins, the applicant and the application row; requires `PENDING`; requires the applicant to still be an active `CUSTOMER` (**409** otherwise; an `ADMIN`, `ADMIN_VIEWER` or `COURIER` is never changed); refuses while the customer owns unfinished shipments (**409**, same rule as a role change); creates or restores the `CourierProfile` (vehicle and plate from the application, available, no licence number); sets `role = COURIER` (and fills an empty account phone from the application); marks the application `APPROVED` with `reviewedBy`/`reviewedAt`; **deletes every session of the applicant**; writes `COURIER_APPLICATION_APPROVED` and `USER_ROLE_CHANGED` audit rows and the applicant's notice.
- **200:** `AdminCourierApplication`. The applicant's old token now gets **401**; their next sign-in carries `COURIER`. Staff get `COURIER_ADDED`.
- **403** `ADMIN_VIEWER` ("This account is read-only", by the central rule).

### `PATCH /admin/courier-applications/:id/reject` (Admin)
**Body:** `{ note (3-500) }`, shown to the applicant. **200:** `AdminCourierApplication` (`REJECTED`). The role and sessions are untouched. **400** missing note, **403** `ADMIN_VIEWER`, **409** not pending.

## Admin

### `GET /admin/dashboard-stats` (Staff)
Cached 60 s. **200:** `{ shipments: { total, byStatus }, revenue: { currency, grossCollected, refunded, net }, paymentsByStatus, shipmentsPerDay: [{ date, count }], topCouriers: [{ id, name, deliveries }], failedDeliveryRate: { rate, failedAttempts, deliveredShipments }, counts: { activeCouriers, activeCustomers, activeHubs }, generatedAt }`.

### `GET /admin/users` (Staff)
Query: `role`, `status`, `searchTerm` (name, email, phone), `sortBy` `name | email | createdAt | role | status`. **200:** `UserProfile[]` + meta.

### `POST /admin/users` (Admin)
- **Body:** `{ name, email, password (8-128), phone?, role (COURIER | ADMIN), courierProfile? }`. A courier needs `courierProfile { zoneId, hubId? | null, vehicleType, vehicleNumber? , licenseNumber? }` (the hub must be active and in the zone).
- **201:** `UserProfile`.

### `PATCH /admin/users/:id/role` (Admin)
**Body:** `{ role (CUSTOMER | COURIER | ADMIN), courierProfile? }`. **200:** `UserProfile`; revokes the user's sessions. **403** your own role, **409** last admin or the user has active shipments. `ADMIN_VIEWER` can never be assigned.

### `PATCH /admin/users/:id/status` (Admin)
**Body:** `{ status (ACTIVE | INACTIVE), reason? (3-500) }`. **200:** `UserProfile`. Deactivation revokes sessions and makes a courier unavailable. **403** yourself, **409** last admin or a courier with active shipments.

### `GET /admin/audit-logs` (Staff)
Query: `actorId`, `action`, `entityType` (`ZONE | HUB | PRICING_RULE | SHIPMENT | COURIER_PROFILE | USER | PAYMENT | COURIER_APPLICATION`), `entityId`, `fromDate`, `toDate`, `sortOrder`.
**200:** `AuditLog[] { id, action, entityType, entityId, actorRole, actor | null, before, after, ipAddress, userAgent, createdAt }` + meta. Snapshots are redacted.

### `GET /admin/payments` (Staff)
Query: `status`, `customerId`, `shipmentId`, `requiresReview`, `fromDate`, `toDate`, `sortBy` `createdAt | amount | paidAt | status`.
**200:** `Payment[]` with an `admin` block (customer, Stripe ids, paid currency, review flag and reason) + meta.

### `POST /admin/payments/:id/refund` (Admin)
Retries or completes a refund that is `REFUND_PENDING`. **200:** the payment (`REFUNDED`); idempotent. **409** for any other status.

## Payments

### `POST /payments/initiate` (Customer)
- **Body:** `{ shipmentId }`
- **201:** `{ paymentId, checkoutUrl, expiresAt, amount, currency, reused: false }`, or **200** with `reused: true` when a session is already open. **409** already paid, **422** below Stripe's minimum.

### `GET /payments/verify?session_id=<Checkout Session id>` (Customer, Admin)
Server-side Stripe lookup for the success page; also applies the payment if the webhook was missed.
**200:** `{ payment, stripe: { sessionStatus, paymentStatus } }`. **404** when the session isn't yours.

### `GET /payments/my` (Customer)
Query: `status`, `sortBy` `createdAt | amount | paidAt | status`. **200:** `Payment[]` (amount, currency, status, timestamps, failure reason and the shipment it pays for) + meta.

### `GET /payments/:id` (Customer own, Staff)
**200:** `Payment` (`checkoutUrl` only while the session is open; staff also get the `admin` block).

### `POST /payments/webhook` (Stripe)
Raw body, `Stripe-Signature` verified. **200** with `data: { eventId, type, outcome }` (the standard envelope); **400** on a bad signature. Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `payment_intent.payment_failed`, `charge.refunded`, `refund.failed`.

## Notifications

Every role; always scoped to the caller. Another user's notification answers **404**, never 403, so ids aren't confirmed.

**Who gets what.** Customers and couriers get shipment and payment updates (created in the same transaction as the change, then emailed). An applicant gets `COURIER_APPLICATION_APPROVED` ("You are now a Carrivo courier… please sign in again", link `/dashboard`) or `COURIER_APPLICATION_REJECTED` (with the admin's note and the reapply date, link `/courier-application`), written in the decision's transaction with `dedupeKey = "<TYPE>:application:<id>:<userId>"`, then emailed through Resend when `RESEND_API_KEY` is set (otherwise `emailStatus: SKIPPED`; an email never fails the request). `ADMIN` and `ADMIN_VIEWER` get an in-app staff feed, written after the change commits (one row per active staff user; inactive or deleted staff are skipped; a failure is logged and never fails the request):

| Type | Event | `link` |
| --- | --- | --- |
| `SHIPMENT_CREATED` | A customer books a shipment | `/admin/shipments/<id>` |
| `PAYMENT_RECEIVED` | A payment is marked paid (webhook or verify) | `/admin/shipments/<id>` |
| `DELIVERED` | A courier delivers | `/admin/shipments/<id>` |
| `FAILED_DELIVERY` | A delivery attempt fails (one per attempt) | `/admin/shipments/<id>` |
| `SHIPMENT_CANCELLED` | A shipment is cancelled (says if a refund is pending) | `/admin/shipments/<id>` |
| `PAYMENT_FAILED` | `checkout.session.async_payment_failed` (card declines and expired sessions stay quiet) | `/admin/payments?status=FAILED` |
| `REFUND_COMPLETED` | A refund completes (API, retry or `charge.refunded`) | `/admin/payments?status=REFUNDED` |
| `REFUND_FAILED` | `refund.failed`, or a refund call that throws | `/admin/payments?requiresReview=true` |
| `ZONE_CHANGED` | A zone is created, updated or deleted | `/admin/settings?tab=zones` |
| `HUB_CHANGED` | A hub is created, updated or deleted | `/admin/settings?tab=hubs` |
| `COURIER_ADDED` | An admin creates a courier, changes a user's role to `COURIER`, or approves a courier application | `/admin/users` |
| `COURIER_APPLICATION_SUBMITTED` | A customer applies to become a courier | `/admin/courier-applications?status=PENDING` |

A staff notice with no better target falls back to `/admin/notifications` (no event uses it today; the frontend has no such page yet). Other status changes (picked up, in transit, ...) don't notify staff.

**Idempotency.** Staff rows store `dedupeKey = "<event key>:<userId>"` under a unique index and are inserted with `createMany(skipDuplicates)`. Keys: `PAYMENT_RECEIVED:payment:<paymentId>` (shared by the webhook and `/payments/verify`), `PAYMENT_FAILED:payment:<paymentId>`, `REFUND_COMPLETED:payment:<paymentId>`, `REFUND_FAILED:payment:<paymentId>:<stripeRefundId>`, `FAILED_DELIVERY:shipment:<id>:attempt:<n>`, `<TYPE>:shipment:<id>` for the other shipment events, `COURIER_APPLICATION_SUBMITTED:application:<id>` and, for an approval, `COURIER_ADDED:application:<id>`. Other admin actions (zones, hubs, users) can't be replayed and have no key. This sits on top of the `stripe_events` table, which already drops a replayed webhook.

### `GET /notifications/my`
Query: `unread` (`true | false`, omit for all), `page`, `limit`, `sortOrder`.
**200:** `Notification[] { id, type, title, message, link, readAt, isRead, createdAt, shipment: { id, trackingId } | null }` + meta. `link` is a frontend path (`null` only on rows written before it existed).

```json
{
  "success": true,
  "message": "Notifications retrieved successfully",
  "data": [
    {
      "id": "01a1c5d4-84b8-7033-9308-9cf99bb0e510",
      "type": "FAILED_DELIVERY",
      "title": "Delivery failed for CRV-261101-SEED12",
      "message": "Attempt 3 of 3 for CRV-261101-SEED12 failed: Recipient not available. No attempts left: mark it returned.",
      "link": "/admin/shipments/01a1c5d3-e58e-7455-8ede-044e8eaf3ecc",
      "readAt": null,
      "isRead": false,
      "createdAt": "2026-11-10T09:20:01.588Z",
      "shipment": { "id": "01a1c5d3-e58e-7455-8ede-044e8eaf3ecc", "trackingId": "CRV-261101-SEED12" }
    }
  ],
  "meta": { "page": 1, "limit": 10, "total": 7, "totalPages": 1 }
}
```

### `GET /notifications/unread-count`
**200:** `{ unread: number, total: number }` for the caller.

### `PATCH /notifications/:id/read`
**200:** the notification (an already-read one keeps its `readAt`). Allowed for `ADMIN_VIEWER`.

### `PATCH /notifications/read-all`
**200:** `{ updated: number }`. Allowed for `ADMIN_VIEWER`.

### `DELETE /notifications/:id`
**200:** `{ id }`. Deletes one of the caller's own notifications (a personal inbox item; shipments, payments and the audit log are untouched). **403** for `ADMIN_VIEWER`.

## Read-only accounts (ADMIN_VIEWER)

- Allowed: every admin and staff `GET` (dashboard stats, users, shipments, payments, audit logs, zones, hubs, pricing rules, couriers, courier applications), `GET /users/me`, its own notifications and unread count, `PATCH /notifications/:id/read` and `PATCH /notifications/read-all` (its own read state, not a business write), and `POST /auth/logout` and `POST /auth/refresh-token`.
- Refused with **403** `This account is read-only`: every other `POST`, `PUT`, `PATCH` and `DELETE`, including its own profile, password, session revocation and deleting a notification.
- Not allowed on customer- or courier-only routes, or on `GET /payments/verify` (it can write).
- The rule is one function, `violatesReadOnly(role, method, url)` in `src/app/middlewares/readOnly.ts`, run inside `authenticate` and in front of Better Auth. `readOnly.test.ts` walks the real route table.

## Security limits

| Limit | Value |
| --- | --- |
| Global rate limit | 300 requests per 15 minutes per visitor (not the Stripe webhook) |
| Auth rate limit | 20 failed attempts per 15 minutes per visitor (login, register, change password, Google start and exchange) |
| Courier applications | 10 submits and cancels per hour per signed-in user |
| JSON body | 100 KB |
| Webhook body | 1 MB, raw |
| Proof image | 4 MB, JPEG, PNG or WebP (bytes checked) |
| Token lifetime | 7 days; rotation needs a still-valid token |
| Google one-time code | 60 seconds, single use, bound to the PKCE verifier |
