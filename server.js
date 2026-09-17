import express from "express";
import * as dotenv from "dotenv";

dotenv.config();

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
const SHOP_PHONE = process.env.SHOP_PHONE || "+234 701 429 8844";

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

/* ----------------------------- ZeptoMail client --------------------------- */

const sendMail = async ({ to, toName, subject, html }) => {
  if (!ZEPTOMAIL_TOKEN) {
    throw new Error("ZeptoMail API token is not configured (set API_TOKEN in .env)");
  }

  // ZeptoMail expects the token prefixed with "Zoho-enczapikey" unless already provided.
  const authorization = ZEPTOMAIL_TOKEN.startsWith("Zoho-")
    ? ZEPTOMAIL_TOKEN
    : `Zoho-enczapikey ${ZEPTOMAIL_TOKEN}`;

  const response = await fetch(`https://${ZEPTOMAIL_HOST}/v1.1/email`, {
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

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`ZeptoMail responded ${response.status}: ${detail.slice(0, 500)}`);
  }

  return response.json().catch(() => ({}));
};

/* --------------------------------- routes --------------------------------- */

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "donut-district-mail-server", timestamp: new Date().toISOString() });
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
    await Promise.all([
      sendMail({
        to: email,
        toName: name,
        subject: `We have received your enquiry — ${reference}`,
        html: enquiryAckHtml(enquiry),
      }),
      sendMail({
        to: SHOP_EMAIL,
        toName: "Donut District",
        subject: `New enquiry ${reference} · ${subject} · ${name}`,
        html: enquiryAdminHtml(enquiry),
      }),
    ]);

    return res.status(201).json({
      ok: true,
      reference,
      message: `Thank you, ${name}. Your enquiry is with our team — expect a reply at ${email} within 24 hours.`,
    });
  } catch (error) {
    console.error(`[enquiry ${reference}] mail delivery failed:`, error.message);
    return res.status(502).json({
      ok: false,
      reference,
      message:
        "Your enquiry reached us, but the confirmation email could not be dispatched right now. Please try again shortly or reach us on the phone line.",
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
    await Promise.all([
      sendMail({
        to: email,
        toName: "New subscriber",
        subject: "Welcome to the Donut District newsletter 🍩",
        html: newsletterWelcomeHtml({ email, reference }),
      }),
      sendMail({
        to: SHOP_EMAIL,
        toName: "Donut District",
        subject: `New newsletter subscriber · ${email}`,
        html: `<p>New subscriber: ${escapeHtml(email)} (ref ${escapeHtml(reference)})</p>`,
      }),
    ]);

    return res.status(201).json({
      ok: true,
      reference,
      message: "You're on the list! Check your inbox for a sweet welcome note.",
    });
  } catch (error) {
    console.error(`[newsletter ${reference}] mail delivery failed:`, error.message);
    return res.status(502).json({
      ok: false,
      reference,
      message: "We could not add you to the list just yet — please try again in a moment.",
    });
  }
});

/* -------------------------------- startup -------------------------------- */

app.listen(PORT, () => console.log(`Donut District mail server running on PORT: ${PORT}`));
