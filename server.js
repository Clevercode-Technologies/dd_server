import express from "express";
import * as dotenv from "dotenv";
import dns from "node:dns";
import net from "node:net";
import { pathToFileURL } from "node:url";

dotenv.config();

/* --------------------- outbound network preferences ----------------------- */

// Some networks (including the one this server was debugged on) resolve
// api.zeptomail.com to a NAT64 IPv6 address that is unroutable. Node's
// happy-eyeballs address selection then waits for it to time out, which surfaces
// only as "fetch failed" / ETIMEDOUT. Prefer IPv4, which ZeptoMail serves
// reliably. Set MAIL_FORCE_IPV4=false to opt out.
if (String(process.env.MAIL_FORCE_IPV4 ?? "true").toLowerCase() !== "false") {
  net.setDefaultAutoSelectFamily?.(false);
  dns.setDefaultResultOrder?.("ipv4first");
}

/* ----------------------------- configuration ----------------------------- */

const PORT = Number(process.env.PORT || 4500);
const ZEPTOMAIL_HOST = process.env.HOST || "api.zeptomail.com";
const ZEPTOMAIL_TOKEN = (process.env.API_TOKEN || process.env.ZEPTOMAIL_API_TOKEN || "").trim();
const DOMAIN = process.env.DOMAIN || "donutdistrict.food";

// Customer-facing sender identity (ZeptoMail verified alias: support@donutdistrict.food)
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || `support@${DOMAIN}`;
const SUPPORT_NAME = process.env.SUPPORT_NAME || "Donut District Support";
const FROM_EMAIL = process.env.FROM_EMAIL || SUPPORT_EMAIL;
const FROM_NAME = process.env.FROM_NAME || SUPPORT_NAME;

// Internal inbox that receives admin copies
const SHOP_EMAIL = process.env.SHOP_EMAIL || "donutdistrictfood@gmail.com";
// Admin inbox that receives new orders (falls back to the shop inbox)
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || SHOP_EMAIL;
const SHOP_PHONE = process.env.SHOP_PHONE || "+234 701 429 8844";

// Authoritative menu prices — the client's total is never trusted.
const PRODUCT_PRICES = {
  "Lagos Nutty Traffic": 1800,
  "Milo Madness": 1600,
  "Zobo Sweet Rush": 1700,
  "Northern Spice Street": 1700,
};

// Mail failures include a concise `detail` field in the API response so a broken
// deployment can be diagnosed without shell access. Set EXPOSE_ERROR_DETAILS=false
// to fall back to generic customer-facing messages.
const EXPOSE_ERROR_DETAILS =
  String(process.env.EXPOSE_ERROR_DETAILS ?? "true").toLowerCase() !== "false";

const app = express();
app.use(express.json({ limit: "100kb" }));

/* --------------------------------- CORS ---------------------------------- */

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

/* ------------------------------ request log ------------------------------ */

app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    console.log(
      `[http] ${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - startedAt}ms)`,
    );
  });
  next();
});

/* ------------------------------ mail helpers ----------------------------- */

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const ticketRef = (prefix) =>
  `${prefix}-${Date.now().toString(36).toUpperCase().slice(-5)}${Math.floor(Math.random() * 90 + 10)}`;

const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const wrapEmail = ({ title, bodyHtml }) => `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f4ede0;font-family:'Manrope','Segoe UI',Helvetica,Arial,sans-serif;color:#3a2e26;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4ede0;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:#fffdf7;border-radius:20px;overflow:hidden;box-shadow:0 12px 32px rgba(58,46,38,0.12);">
            <tr>
              <td style="background-color:#3a2e26;padding:28px 36px;text-align:center;">
                <span style="font-size:22px;font-weight:700;letter-spacing:1px;color:#f7f1e4;font-family:Georgia,'Times New Roman',serif;">Donut District</span>
                <p style="margin:6px 0 0;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#c98d55;">Baked fresh, every morning</p>
              </td>
            </tr>
            <tr>
              <td style="padding:36px;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:24px 36px;border-top:1px solid #ece2cf;">
                <p style="margin:0;font-size:12px;line-height:1.6;color:#8a7a68;">
                  Donut District · Benin City, Edo State, Nigeria<br />
                  Phone: ${escapeHtml(SHOP_PHONE)} · Email: ${escapeHtml(SHOP_EMAIL)}
                </p>
                <p style="margin:10px 0 0;font-size:11px;color:#b3a48f;">
                  © ${new Date().getFullYear()} Donut District. Glazed with intent.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
  </html>
`;

/* -------------------------------- templates ------------------------------- */

const enquiryAckHtml = ({ name, subject, reference }) =>
  wrapEmail({
    title: `Enquiry received · Donut District`,
    bodyHtml: `
      <h1 style="margin:0 0 8px;font-size:22px;font-family:Georgia,'Times New Roman',serif;color:#3a2e26;">
        Thank you, ${escapeHtml(name)}!
      </h1>
      <p style="margin:0 0 24px;font-size:14px;line-height:1.7;color:#5c4d40;">
        We have received your enquiry regarding <strong>${escapeHtml(subject)}</strong> and one of
        our team members will be in touch at this address within 24 hours.
      </p>
      <p style="margin:0 0 6px;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#c98d55;">Reference</p>
      <p style="margin:0 0 24px;font-size:16px;font-weight:700;color:#3a2e26;">${escapeHtml(reference)}</p>
      <p style="margin:0 0 24px;font-size:14px;line-height:1.7;color:#5c4d40;">
        If your enquiry is about an order for an event or a bulk purchase, feel free to reply with
        the date and quantity so we can plan the batch ahead of your request.
      </p>
      <p style="margin:0 0 0;font-size:14px;color:#3a2e26;">
        Warm regards,<br />
        <span style="font-family:Georgia,'Times New Roman',serif;font-style:italic;">Donut District Support</span>
      </p>
    `,
  });

const enquiryAdminHtml = ({ name, email, phone, subject, message, reference }) =>
  wrapEmail({
    title: `New enquiry ${reference} · Donut District`,
    bodyHtml: `
      <h1 style="margin:0 0 16px;font-size:20px;font-family:Georgia,'Times New Roman',serif;color:#3a2e26;">
        New enquiry — ${escapeHtml(reference)}
      </h1>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f9f3e6;border-radius:14px;padding:8px 20px;">
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #ece2cf;font-size:13px;color:#8a7a68;width:90px;">Name</td>
          <td style="padding:10px 0;border-bottom:1px solid #ece2cf;font-size:14px;color:#3a2e26;font-weight:600;">${escapeHtml(name)}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #ece2cf;font-size:13px;color:#8a7a68;">Email</td>
          <td style="padding:10px 0;border-bottom:1px solid #ece2cf;font-size:14px;color:#3a2e26;">${escapeHtml(email)}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #ece2cf;font-size:13px;color:#8a7a68;">Phone</td>
          <td style="padding:10px 0;border-bottom:1px solid #ece2cf;font-size:14px;color:#3a2e26;">${phone ? escapeHtml(phone) : "—"}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;font-size:13px;color:#8a7a68;">Subject</td>
          <td style="padding:10px 0;font-size:14px;color:#3a2e26;font-weight:600;">${escapeHtml(subject)}</td>
        </tr>
      </table>
      <p style="margin:20px 0 6px;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#c98d55;">Message</p>
      <p style="margin:0;font-size:14px;line-height:1.8;color:#3a2e26;white-space:pre-line;">${escapeHtml(message)}</p>
    `,
  });

const newsletterWelcomeHtml = ({ email, reference }) =>
  wrapEmail({
    title: `Welcome to the sweet list · Donut District`,
    bodyHtml: `
      <h1 style="margin:0 0 8px;font-size:22px;font-family:Georgia,'Times New Roman',serif;color:#3a2e26;">
        You're on the list! 🍩
      </h1>
      <p style="margin:0 0 24px;font-size:14px;line-height:1.7;color:#5c4d40;">
        Thank you for joining the Donut District newsletter. Every week we share the freshest
        flavour drops, behind-the-scenes peeks at the counter, and subscriber-first treats we
        don't post anywhere else.
      </p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f9f3e6;border-radius:14px;padding:16px 20px;">
        <tr>
          <td style="font-size:14px;line-height:1.9;color:#3a2e26;">
            <strong>Here's what to expect:</strong><br />
            ▪️ Weekly flavour drops before they hit the counter<br />
            ▪️ Subscriber-only treats on the day's batch<br />
            ▪️ First word on seasonal specials and pop-ups
          </td>
        </tr>
      </table>
      <p style="margin:24px 0 0;font-size:14px;line-height:1.7;color:#5c4d40;">
        We've logged <strong>${escapeHtml(email)}</strong> on the list under reference
        <strong>${escapeHtml(reference)}</strong>. Whenever you're ready to grab a box, you know
        where to find us — baked fresh, every morning.
      </p>
      <p style="margin:24px 0 0;font-size:14px;color:#3a2e26;">
        Warm regards,<br />
        <span style="font-family:Georgia,'Times New Roman',serif;font-style:italic;">The Donut District Team</span>
      </p>
    `,
  });

const naira = (value) => `₦${Number(value).toLocaleString("en-NG")}`;

const orderItemsTableHtml = (items) => `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f9f3e6;border-radius:14px;padding:8px 20px;">
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #ece2cf;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#8a7a68;">Item</td>
          <td style="padding:10px 0;border-bottom:1px solid #ece2cf;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#8a7a68;text-align:center;">Qty</td>
          <td style="padding:10px 0;border-bottom:1px solid #ece2cf;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#8a7a68;text-align:right;">Amount</td>
        </tr>
        ${items
          .map(
            (item) => `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #ece2cf;font-size:14px;color:#3a2e26;font-weight:600;">${escapeHtml(item.name)}</td>
          <td style="padding:10px 0;border-bottom:1px solid #ece2cf;font-size:14px;color:#3a2e26;text-align:center;">${escapeHtml(item.quantity)}</td>
          <td style="padding:10px 0;border-bottom:1px solid #ece2cf;font-size:14px;color:#3a2e26;text-align:right;">${escapeHtml(naira(item.lineTotal))}</td>
        </tr>`,
          )
          .join("")}
        <tr>
          <td style="padding:12px 0;font-size:14px;color:#3a2e26;font-weight:700;" colspan="2">Total</td>
          <td style="padding:12px 0;font-size:16px;color:#3a2e26;font-weight:700;text-align:right;">${escapeHtml(naira(items.reduce((sum, item) => sum + item.lineTotal, 0)))}</td>
        </tr>
      </table>`;

const orderAckHtml = ({ name, reference, items, fulfillment, note }) =>
  wrapEmail({
    title: `Order received · Donut District`,
    bodyHtml: `
      <h1 style="margin:0 0 8px;font-size:22px;font-family:Georgia,'Times New Roman',serif;color:#3a2e26;">
        Thank you, ${escapeHtml(name)}! 🍩
      </h1>
      <p style="margin:0 0 24px;font-size:14px;line-height:1.7;color:#5c4d40;">
        We have received your order and our bakers are on it. We will reach out shortly to
        confirm ${
          fulfillment === "delivery"
            ? "your delivery details and payment"
            : "your pickup time and payment"
        }. Keep this reference handy when you contact us.
      </p>
      <p style="margin:0 0 6px;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#c98d55;">Reference</p>
      <p style="margin:0 0 24px;font-size:16px;font-weight:700;color:#3a2e26;">${escapeHtml(reference)}</p>
      ${orderItemsTableHtml(items)}
      <p style="margin:20px 0 6px;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#c98d55;">Fulfilment</p>
      <p style="margin:0;font-size:14px;line-height:1.7;color:#5c4d40;">
        ${escapeHtml(fulfillment === "delivery" ? "Delivery across Benin City" : "Pickup at the counter")}${
          note ? `<br /><span style="color:#8a7a68;">Note: ${escapeHtml(note)}</span>` : ""
        }
      </p>
      <p style="margin:24px 0 0;font-size:14px;color:#3a2e26;">
        Warm regards,<br />
        <span style="font-family:Georgia,'Times New Roman',serif;font-style:italic;">The Donut District Team</span>
      </p>
    `,
  });

const orderAdminHtml = ({ name, email, phone, reference, items, fulfillment, note }) =>
  wrapEmail({
    title: `New order ${reference} · Donut District`,
    bodyHtml: `
      <h1 style="margin:0 0 16px;font-size:20px;font-family:Georgia,'Times New Roman',serif;color:#3a2e26;">
        New order — ${escapeHtml(reference)}
      </h1>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f9f3e6;border-radius:14px;padding:8px 20px;">
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #ece2cf;font-size:13px;color:#8a7a68;width:90px;">Customer</td>
          <td style="padding:10px 0;border-bottom:1px solid #ece2cf;font-size:14px;color:#3a2e26;font-weight:600;">${escapeHtml(name)}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #ece2cf;font-size:13px;color:#8a7a68;">Email</td>
          <td style="padding:10px 0;border-bottom:1px solid #ece2cf;font-size:14px;color:#3a2e26;">${escapeHtml(email)}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #ece2cf;font-size:13px;color:#8a7a68;">Phone</td>
          <td style="padding:10px 0;border-bottom:1px solid #ece2cf;font-size:14px;color:#3a2e26;">${escapeHtml(phone)}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;font-size:13px;color:#8a7a68;">Fulfilment</td>
          <td style="padding:10px 0;font-size:14px;color:#3a2e26;font-weight:600;">${escapeHtml(fulfillment === "delivery" ? "Delivery" : "Pickup")}</td>
        </tr>
      </table>
      <p style="margin:20px 0 6px;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#c98d55;">Items</p>
      ${orderItemsTableHtml(items)}
      ${
        note
          ? `<p style="margin:20px 0 6px;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#c98d55;">Note</p>
       <p style="margin:0;font-size:14px;line-height:1.8;color:#3a2e26;white-space:pre-line;">${escapeHtml(note)}</p>`
          : ""
      }
    `,
  });

/* ----------------------------- ZeptoMail client --------------------------- */

/** Walks Node's nested `cause` chain — "fetch failed" hides the real DNS/TLS/socket error. */
const describeCauseChain = (error) => {
  const parts = [];
  const seen = new Set();
  let current = error;

  while (current && !seen.has(current) && parts.length < 4) {
    seen.add(current);
    const code = current.code ?? current.errno;
    const message = current.message ?? String(current);
    parts.push(code && !message.includes(String(code)) ? `${message} (${code})` : message);
    current = current.cause;
  }

  return parts.join(" ← ") || "unknown network error";
};

/** Human-readable reason for a failed send — never swallow the provider's answer. */
const describeMailError = (error) => {
  if (!error) return "unknown error";
  const status = error.status ? `HTTP ${error.status} — ` : "";
  const message = error.message ?? String(error);
  const provider = error.providerDetail ? ` · provider said: ${error.providerDetail}` : "";
  return `${status}${message}${provider}`;
};

const zeptoMailTransport = async ({ to, toName, subject, html }) => {
  if (!ZEPTOMAIL_TOKEN) {
    const error = new Error(
      "ZEPTOMAIL_API_TOKEN is not configured on this server (checked API_TOKEN and ZEPTOMAIL_API_TOKEN)",
    );
    error.code = "MAIL_TOKEN_MISSING";
    throw error;
  }

  // ZeptoMail expects the token prefixed with "Zoho-enczapikey" unless already provided.
  const authorization = ZEPTOMAIL_TOKEN.startsWith("Zoho-")
    ? ZEPTOMAIL_TOKEN
    : `Zoho-enczapikey ${ZEPTOMAIL_TOKEN}`;

  let response;
  try {
    response = await fetch(`https://${ZEPTOMAIL_HOST}/v1.1/email`, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        from: { address: FROM_EMAIL, name: FROM_NAME },
        to: [{ email_address: { address: to, name: toName } }],
        subject,
        htmlbody: html,
      }),
    });
  } catch (cause) {
    // Network-level failure (wrong HOST, DNS, TLS, timeouts) — keep the whole cause chain visible.
    const error = new Error(`Could not reach ${ZEPTOMAIL_HOST} — ${describeCauseChain(cause)}`);
    error.code = "MAIL_NETWORK_ERROR";
    error.cause = cause;
    throw error;
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const error = new Error(`ZeptoMail rejected the message (status ${response.status})`);
    error.status = response.status;
    error.providerDetail = detail.slice(0, 500);
    throw error;
  }

  return response.json().catch(() => ({}));
};

// Swappable so tests (or a future provider) can replace the transport.
let mailTransport = zeptoMailTransport;
const setMailTransport = (transport) => {
  mailTransport = transport;
};

/**
 * Sends every message independently and logs each outcome with its recipient and
 * subject, so a partial failure can never pass silently again.
 */
const deliverAll = async (messages) => {
  const settled = await Promise.allSettled(
    messages.map(({ to, toName, subject, html }) => mailTransport({ to, toName, subject, html })),
  );

  settled.forEach((result, index) => {
    const { to, subject } = messages[index];
    if (result.status === "fulfilled") {
      console.log(`[mail] sent → ${to} · "${subject}"`);
    } else {
      console.error(`[mail] FAILED → ${to} · "${subject}" · ${describeMailError(result.reason)}`);
    }
  });

  return settled;
};

const firstMailFailure = (settled) =>
  settled.find((result) => result.status === "rejected")?.reason ?? null;

/** Non-secret view of the mail configuration, safe to expose on /api/health. */
const mailConfigSnapshot = () => ({
  host: ZEPTOMAIL_HOST,
  tokenConfigured: Boolean(ZEPTOMAIL_TOKEN),
  tokenPrefixed: ZEPTOMAIL_TOKEN.startsWith("Zoho-"),
  tokenLength: ZEPTOMAIL_TOKEN.length,
  from: FROM_EMAIL,
  supportInbox: SHOP_EMAIL,
  adminInbox: ADMIN_EMAIL,
  exposeErrorDetails: EXPOSE_ERROR_DETAILS,
});

/** Adds a diagnostic `detail` field to failure responses while debugging is on. */
const failurePayload = (error) =>
  EXPOSE_ERROR_DETAILS ? { detail: describeMailError(error) } : {};

/* --------------------------------- routes --------------------------------- */

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "donut-district-mail-server",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    mail: mailConfigSnapshot(),
  });
});
app.post("/api/enquiry", async (req, res) => {
  const body = req.body ?? {};
  const name = String(body.name ?? "").trim();
  const phone = String(body.phone ?? "").trim();
  const email = String(body.email ?? "").trim();
  const subject = String(body.subject ?? "").trim();
  const message = String(body.message ?? "").trim();

  // --- validation ----------------------------------------------------------
  const errors = [];
  if (name.length < 2) errors.push("Please tell us your name.");
  if (!isEmail(email)) errors.push("Please provide a valid email address so we can reply to you.");
  if (phone && phone.replace(/\D/g, "").length < 7)
    errors.push("The phone number provided is not valid.");
  if (subject.length < 3) errors.push("Please add a short subject for your enquiry.");
  if (message.length < 10) errors.push("Please describe your enquiry in a little more detail.");

  if (errors.length > 0) {
    return res.status(400).json({ ok: false, message: errors[0], errors });
  }

  const reference = ticketRef("ENQ");
  const enquiry = { name, email, phone, subject, message, reference };

  // --- emails --------------------------------------------------------------
  try {
    const settled = await deliverAll([
      {
        to: email,
        toName: name,
        subject: `We have received your enquiry — ${reference}`,
        html: enquiryAckHtml(enquiry),
      },
      {
        to: SHOP_EMAIL,
        toName: "Donut District",
        subject: `New enquiry ${reference} · ${subject} · ${name}`,
        html: enquiryAdminHtml(enquiry),
      },
    ]);

    const failure = firstMailFailure(settled);
    if (failure) {
      console.error(`[enquiry ${reference}] delivery incomplete · ${describeMailError(failure)}`);
      return res.status(502).json({
        ok: false,
        reference,
        message:
          "Your enquiry reached us, but the confirmation email could not be dispatched right now. Please try again shortly or reach us on the phone line.",
        ...failurePayload(failure),
      });
    }

    return res.status(201).json({
      ok: true,
      reference,
      message: `Thank you, ${name}. Your enquiry is with our team — expect a reply at ${email} within 24 hours.`,
    });
  } catch (error) {
    console.error(`[enquiry ${reference}] unexpected failure:`, error);
    return res.status(500).json({
      ok: false,
      reference,
      message: "Something went wrong while preparing your enquiry.",
      ...failurePayload(error),
    });
  }
});

/* ------------------------------- newsletter ------------------------------- */

app.post("/api/newsletter", async (req, res) => {
  const body = req.body ?? {};
  const email = String(body.email ?? "").trim().toLowerCase();

  if (!isEmail(email)) {
    return res.status(400).json({
      ok: false,
      message: "Please provide a valid email address to join the list.",
    });
  }

  const reference = ticketRef("SUB");
  try {
    const settled = await deliverAll([
      {
        to: email,
        toName: "New subscriber",
        subject: "Welcome to the Donut District newsletter 🍩",
        html: newsletterWelcomeHtml({ email, reference }),
      },
      {
        to: SHOP_EMAIL,
        toName: "Donut District",
        subject: `New newsletter subscriber · ${email}`,
        html: `<p>New subscriber: ${escapeHtml(email)} (ref ${escapeHtml(reference)})</p>`,
      },
    ]);

    const failure = firstMailFailure(settled);
    if (failure) {
      console.error(`[newsletter ${reference}] delivery incomplete · ${describeMailError(failure)}`);
      return res.status(502).json({
        ok: false,
        reference,
        message: "We could not add you to the list just yet — please try again in a moment.",
        ...failurePayload(failure),
      });
    }

    return res.status(201).json({
      ok: true,
      reference,
      message: "You're on the list! Check your inbox for a sweet welcome note.",
    });
  } catch (error) {
    console.error(`[newsletter ${reference}] unexpected failure:`, error);
    return res.status(500).json({
      ok: false,
      reference,
      message: "Something went wrong while subscribing you.",
      ...failurePayload(error),
    });
  }
});

/* --------------------------------- orders --------------------------------- */

app.post("/api/order", async (req, res) => {
  const body = req.body ?? {};
  const name = String(body.name ?? "").trim();
  const email = String(body.email ?? "").trim();
  const phone = String(body.phone ?? "").trim();
  const fulfillment = body.fulfillment === "delivery" ? "delivery" : "pickup";
  const note = String(body.note ?? "").trim().slice(0, 1000);

  // --- validation -----------------------------------------------------------
  const errors = [];
  if (name.length < 2) errors.push("Please tell us your name.");
  if (!isEmail(email))
    errors.push("Please provide a valid email address so we can send you an order confirmation.");
  if (phone.replace(/\D/g, "").length < 7)
    errors.push("Please provide a valid phone number so we can confirm your order.");

  // Rebuild the items from the trusted price list instead of trusting the client.
  const rawItems = Array.isArray(body.items) ? body.items : [];
  const items = rawItems
    .map((item) => {
      const productName = String(item?.name ?? "").trim();
      const quantity = Math.floor(Number(item?.quantity ?? 0));
      if (!Object.prototype.hasOwnProperty.call(PRODUCT_PRICES, productName) || quantity <= 0) {
        return null;
      }
      return {
        name: productName,
        quantity,
        unitPrice: PRODUCT_PRICES[productName],
        lineTotal: PRODUCT_PRICES[productName] * quantity,
      };
    })
    .filter(Boolean);

  if (items.length === 0) errors.push("Add at least one donut to send your order.");
  if (fulfillment === "delivery" && note.length < 5)
    errors.push("Please add a delivery address so we know where to bring your donuts.");

  if (errors.length > 0) {
    return res.status(400).json({ ok: false, message: errors[0], errors });
  }

  const total = items.reduce((sum, item) => sum + item.lineTotal, 0);
  const reference = ticketRef("ORD");
  const order = { name, email, phone, reference, items, fulfillment, note, total };

  // --- emails ---------------------------------------------------------------
  try {
    const settled = await deliverAll([
      {
        to: email,
        toName: name,
        subject: `We have received your order 🍩 — ${reference}`,
        html: orderAckHtml(order),
      },
      {
        to: ADMIN_EMAIL,
        toName: "Donut District",
        subject: `New order ${reference} · ${naira(total)} · ${name}`,
        html: orderAdminHtml(order),
      },
    ]);

    const [customerMail, adminMail] = settled;
    const adminError = adminMail.status === "rejected" ? adminMail.reason : null;
    const customerError = customerMail.status === "rejected" ? customerMail.reason : null;

    // The kitchen must receive the order, otherwise the customer needs to be told.
    if (adminError) {
      console.error(`[order ${reference}] admin copy failed · ${describeMailError(adminError)}`);
      return res.status(502).json({
        ok: false,
        reference,
        message:
          "Your order could not be sent right now — please try again in a moment or give us a call.",
        ...failurePayload(adminError),
      });
    }

    // Order landed with the kitchen; a failed receipt must stay visible but never block it.
    return res.status(201).json({
      ok: true,
      reference,
      message: `Thank you, ${name}. Your order is in — a confirmation is on its way to ${email}.`,
      ...(customerError
        ? {
            warning: `Order received, but the confirmation email to ${email} could not be delivered.`,
            ...failurePayload(customerError),
          }
        : {}),
    });
  } catch (error) {
    console.error(`[order ${reference}] unexpected failure:`, error);
    return res.status(500).json({
      ok: false,
      reference,
      message: "Something went wrong while placing your order.",
      ...failurePayload(error),
    });
  }
});

/* -------------------------------- startup -------------------------------- */

// Only bind a port when this file is executed directly (`npm start`), so tests and
// other imports can use the exported app without starting a listener.
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  app.listen(PORT, () => {
    console.log(`Donut District mail server running on PORT: ${PORT}`);
    console.log(`[config] ${JSON.stringify(mailConfigSnapshot())}`);

    if (!ZEPTOMAIL_TOKEN) {
      console.error(
        "[config] ZEPTOMAIL_API_TOKEN is missing — every enquiry, order and newsletter will fail with a 502 until it is set and the service is redeployed",
      );
    }
  });
}

export { app, describeCauseChain, mailConfigSnapshot, setMailTransport };
