import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FRONTEND_PATHS } from "../../config/frontendRoutes.js";
import { buildNotification, escapeHtml, formatAmount, renderEmail, type NotificationInput, type ShipmentFacts } from "./notification.utils.js";

const shipment: ShipmentFacts = {
  id: "0195f2a1-0000-7000-8000-000000000001",
  trackingId: "CRV-261106-ABC123",
  receiverName: "Rahim Uddin",
  deliveryAddress: "200 N Spring St, Los Angeles, CA 90012",
  serviceType: "SAME_DAY",
  price: "6.00",
  currency: "usd",
};
const at = new Date("2026-11-06T09:15:30Z");
const pickup = { address: "350 5th Ave, New York, NY 10118", contactName: "Emily", windowStart: at, windowEnd: new Date("2026-11-06T11:00:00Z") };

const ALL: NotificationInput[] = [
  { type: "SHIPMENT_CREATED", shipment },
  { type: "COURIER_ASSIGNED", audience: "CUSTOMER", shipment, courierName: "Karim Courier", pickup },
  { type: "COURIER_ASSIGNED", audience: "COURIER", shipment, courierName: "Karim Courier", pickup },
  { type: "PICKED_UP", shipment, at },
  { type: "OUT_FOR_DELIVERY", shipment },
  { type: "DELIVERED", shipment, at },
  { type: "FAILED_DELIVERY", shipment, reason: "Receiver not home", attempt: 1, maxAttempts: 3 },
  { type: "PAYMENT_RECEIVED", shipment, amount: "6.00", currency: "usd", at },
  { type: "REFUND_COMPLETED", shipment, amount: "6.00", currency: "usd" },
];

const render = (input: NotificationInput) =>
  renderEmail(buildNotification(input), { recipientName: "Ayesha Customer", frontendOrigin: "https://app.example.com" });

describe("buildNotification", () => {
  it("every type has a title and message containing the tracking id", () => {
    for (const input of ALL) {
      const content = buildNotification(input);
      assert.equal(content.type, input.type);
      assert.match(content.title, /CRV-261106-ABC123/, input.type);
      assert.match(content.message, /CRV-261106-ABC123/, input.type);
    }
  });

  it("customer notifications link to the shipment page, courier ones to the task page", () => {
    for (const input of ALL) {
      const expected =
        input.type === "COURIER_ASSIGNED" && input.audience === "COURIER"
          ? FRONTEND_PATHS.courierTask(shipment.id)
          : FRONTEND_PATHS.customerShipment(shipment.id);
      assert.equal(buildNotification(input).linkPath, expected, input.type);
    }
  });

  it("money is shown as USD and the customer only sees the courier's first name", () => {
    assert.match(buildNotification(ALL[0]!).message, /\$6\.00 USD/);
    assert.match(buildNotification(ALL[7]!).message, /\$6\.00 USD/);
    assert.equal(formatAmount("6.00", "eur"), "6.00 EUR");
    const customer = buildNotification(ALL[1]!);
    assert.match(customer.message, /^Karim will pick up/);
    assert.doesNotMatch(customer.message, /Courier$/);
  });

  it("the courier task includes the pickup address and window", () => {
    const courier = buildNotification(ALL[2]!);
    assert.ok(courier.details.includes("Pickup address: 350 5th Ave, New York, NY 10118"));
    assert.ok(courier.details.includes("Pickup window: Nov 6, 2026, 4:15 AM EST to Nov 6, 2026, 6:00 AM EST"));
  });

  it("failed delivery explains what happens next, including the final attempt", () => {
    assert.match(buildNotification(ALL[6]!).message, /attempt 1 of 3 for CRV-261106-ABC123 failed: Receiver not home\. We will try again\./);
    const final = buildNotification({ type: "FAILED_DELIVERY", shipment, reason: "Refused", attempt: 3, maxAttempts: 3 });
    assert.match(final.message, /final attempt/);
  });
});

describe("renderEmail", () => {
  it("is branded, includes the tracking id and an absolute link from the frontend origin", () => {
    for (const input of ALL) {
      const email = render(input);
      assert.match(email.subject, /^Carrivo: /);
      assert.match(email.subject, /CRV-261106-ABC123/);
      const link = `https://app.example.com${buildNotification(input).linkPath}`;
      assert.ok(email.text.includes(link), input.type);
      assert.ok(email.html.includes(`href="${link}"`), input.type);
      assert.match(email.text, /^Hi Ayesha,/);
      assert.match(email.html, /Carrivo/);
      assert.match(email.text, /do not reply/);
    }
  });

  it("does not double the slash when the origin has a trailing slash", () => {
    const email = renderEmail(buildNotification(ALL[0]!), { recipientName: "A", frontendOrigin: "https://app.example.com/" });
    assert.ok(email.text.includes(`https://app.example.com/shipments/${shipment.id}`));
  });

  it("escapes user-supplied text in the HTML version", () => {
    const evil = { ...shipment, receiverName: '<img src=x onerror="alert(1)">' };
    const email = renderEmail(buildNotification({ type: "OUT_FOR_DELIVERY", shipment: evil }), {
      recipientName: "<b>Eve</b>",
      frontendOrigin: "https://app.example.com",
    });
    assert.doesNotMatch(email.html, /<img src=x/);
    assert.match(email.html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.doesNotMatch(email.html, /<b>Eve<\/b>/);
    assert.equal(escapeHtml(`a&b<'"`), "a&amp;b&lt;&#39;&quot;");
  });

  it("never contains a proof-of-delivery URL or a token", () => {
    for (const input of ALL) {
      const { text, html } = render(input);
      assert.doesNotMatch(text + html, /cloudinary|token|Bearer/i, input.type);
    }
  });
});
