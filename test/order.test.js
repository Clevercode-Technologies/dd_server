import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { app, describeCauseChain, mailConfigSnapshot, setMailTransport } from "../server.js";

/* ------------------------------- test harness ------------------------------ */

/**
 * Runs the real Express app on an ephemeral port with the mail transport swapped
 * for a recorder, so the HTTP contract and the emails themselves can be asserted
 * without ever calling ZeptoMail.
 */

let mailbox = [];
let shouldFail = () => false;

setMailTransport(async (message) => {
  mailbox.push(message);
  if (shouldFail(message)) {
    const error = new Error("ZeptoMail rejected the message (status 401)");
    error.status = 401;
    error.providerDetail = '{"error":{"code":"EM_102","message":"Invalid API token"}}';
    throw error;
  }
  return { ok: true };
});

const resetMailbox = () => {
  mailbox = [];
  shouldFail = () => false;
};

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const postJson = async (path, payload) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

const validOrder = () => ({
  name: "Ada Okafor",
  email: "ada.okafor@example.com",
  phone: "0803 123 4567",
  fulfillment: "pickup",
  note: "Pickup by 4pm, no peanuts please",
  items: [
    { name: "Lagos Nutty Traffic", quantity: 2 },
    { name: "Milo Madness", quantity: 1 },
  ],
});

/* ---------------------------------- tests ---------------------------------- */

describe("POST /api/order", () => {
  it("emails the customer a receipt and the admin the full order", async () => {
    resetMailbox();
    const { status, body } = await postJson("/api/order", validOrder());

    assert.equal(status, 201);
    assert.equal(body.ok, true);
    assert.match(body.reference, /^ORD-[A-Z0-9]+$/);

    assert.equal(mailbox.length, 2, "one email per recipient");
    const [customer, admin] = mailbox;

    assert.equal(customer.to, "ada.okafor@example.com");
    assert.match(customer.subject, /we have received your order/i);
    assert.match(customer.html, /Ada Okafor/);
    assert.match(customer.html, /Lagos Nutty Traffic/);
    assert.match(customer.html, /₦5,200/); // 2 × ₦1,800 + ₦1,600, computed server-side

    assert.equal(admin.to, mailConfigSnapshot().adminInbox);
    assert.match(admin.subject, new RegExp(body.reference));
    assert.match(admin.subject, /₦5,200/);
    assert.match(admin.html, /0803 123 4567/);
    assert.match(admin.html, /Pickup by 4pm/);
  });

  it("recomputes the total server-side and drops unknown products", async () => {
    resetMailbox();
    const { status } = await postJson("/api/order", {
      ...validOrder(),
      total: 1, // tampered client-side values must be ignored
      items: [
        { name: "Milo Madness", quantity: 2, unitPrice: 1, lineTotal: 2 },
        { name: "Free Donut Of Doom", quantity: 99 },
      ],
    });

    assert.equal(status, 201);
    const [customer, admin] = mailbox;
    assert.match(customer.html, /₦3,200/); // 2 × ₦1,600 only
    assert.doesNotMatch(customer.html, /Free Donut Of Doom/);
    assert.doesNotMatch(admin.html, /Free Donut Of Doom/);
    assert.match(admin.subject, /₦3,200/);
  });

  it("rejects an order without a valid email or phone", async () => {
    resetMailbox();
    const { status, body } = await postJson("/api/order", {
      ...validOrder(),
      email: "nope",
      phone: "12",
    });

    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.ok(body.errors.some((message) => /email address/i.test(message)));
    assert.ok(body.errors.some((message) => /phone number/i.test(message)));
    assert.equal(mailbox.length, 0, "invalid orders never reach the mail provider");
  });

  it("requires at least one real donut", async () => {
    resetMailbox();
    const { status, body } = await postJson("/api/order", {
      ...validOrder(),
      items: [{ name: "Mystery Donut", quantity: 3 }],
    });

    assert.equal(status, 400);
    assert.match(body.message, /add at least one donut/i);
    assert.equal(mailbox.length, 0);
  });

  it("requires a delivery address for delivery orders", async () => {
    resetMailbox();
    const { status, body } = await postJson("/api/order", {
      ...validOrder(),
      fulfillment: "delivery",
      note: "n/a",
    });

    assert.equal(status, 400);
    assert.match(body.message, /delivery address/i);
    assert.equal(mailbox.length, 0);
  });

  it("returns 502 with the provider reason when the admin copy fails", async () => {
    resetMailbox();
    shouldFail = (message) => message.to === mailConfigSnapshot().adminInbox;
    const { status, body } = await postJson("/api/order", validOrder());

    assert.equal(status, 502);
    assert.equal(body.ok, false);
    assert.match(body.reference, /^ORD-[A-Z0-9]+$/);
    assert.match(body.detail, /401/);
    assert.match(body.detail, /Invalid API token/);
  });

  it("still accepts the order when only the customer receipt fails", async () => {
    resetMailbox();
    const order = validOrder();
    shouldFail = (message) => message.to === order.email;
    const { status, body } = await postJson("/api/order", order);

    assert.equal(status, 201);
    assert.equal(body.ok, true);
    assert.match(body.warning, /confirmation email/i);
    assert.match(body.detail, /401/);
  });
});

describe("POST /api/newsletter", () => {
  it("welcomes the subscriber and notifies the shop", async () => {
    resetMailbox();
    const { status, body } = await postJson("/api/newsletter", { email: "fan@example.com" });

    assert.equal(status, 201);
    assert.equal(body.ok, true);
    assert.equal(mailbox.length, 2);
    assert.equal(mailbox[0].to, "fan@example.com");
    assert.equal(mailbox[1].to, mailConfigSnapshot().supportInbox);
  });

  it("reports the provider reason when delivery fails", async () => {
    resetMailbox();
    shouldFail = () => true;
    const { status, body } = await postJson("/api/newsletter", { email: "fan@example.com" });

    assert.equal(status, 502);
    assert.match(body.detail, /Invalid API token/);
  });
});

describe("GET /api/health", () => {
  it("reports mail configuration without leaking the token", async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(typeof body.mail.host, "string");
    assert.equal(typeof body.mail.tokenConfigured, "boolean");
    assert.equal(typeof body.mail.adminInbox, "string");
    assert.ok(!JSON.stringify(body).includes("Zoho-enczapikey"));
  });
});

describe("mail error diagnostics", () => {
  it("flattens nested network causes so the real reason is never hidden", () => {
    const socketError = Object.assign(
      new Error("connect ETIMEDOUT 64:ff9b::888f:bfa2:443"),
      { code: "ETIMEDOUT" },
    );
    const familyError = Object.assign(new Error("socket hang up"), {
      code: "ETIMEDOUT",
      cause: socketError,
    });
    const fetchError = new TypeError("fetch failed", { cause: familyError });

    const described = describeCauseChain(fetchError);

    assert.match(described, /fetch failed/);
    assert.match(described, /ETIMEDOUT/);
    assert.match(described, /64:ff9b::888f:bfa2:443/);
  });

  it("copes with a simple error", () => {
    assert.equal(describeCauseChain(new Error("boom")), "boom");
  });
});
