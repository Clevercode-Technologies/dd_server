#!/usr/bin/env node
/**
 * Simulates the exact requests the website makes, so mail problems are visible
 * from the outside.
 *
 *   node scripts/probe-order.mjs                          # full order (sends real mail)
 *   node scripts/probe-order.mjs --invalid                # validation only (sends nothing)
 *   node scripts/probe-order.mjs --email=you@example.com  # where the receipt should land
 *   node scripts/probe-order.mjs --url=http://localhost:4500
 */

const args = process.argv.slice(2);
const option = (name, fallback) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? fallback;

const baseUrl = option("url", process.env.SERVER_URI || "https://dd-server-jtzn.onrender.com").replace(
  /\/$/,
  "",
);
const receiptAddress = option("email", "order-probe@example.com");
const invalidOnly = args.includes("--invalid");

const payload = invalidOnly
  ? { name: "T", email: "bad", phone: "1", items: [] }
  : {
      name: "Order Probe (automated test)",
      email: receiptAddress,
      phone: "08030000000",
      fulfillment: "pickup",
      note: "Automated connectivity probe — please ignore this order.",
      items: [
        { name: "Lagos Nutty Traffic", quantity: 1 },
        { name: "Milo Madness", quantity: 1 },
      ],
    };

const request = async (path, body) => {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, ms: Date.now() - startedAt, parsed };
};

const show = (result) =>
  typeof result.parsed === "string"
    ? result.parsed.slice(0, 400)
    : JSON.stringify(result.parsed, null, 2);

const main = async () => {
  console.log(`→ GET  ${baseUrl}/api/health`);
  const health = await request("/api/health");
  console.log(`  ${health.status} (${health.ms}ms)`);
  console.log(`  ${show(health)}`);

  console.log(
    `\n→ POST ${baseUrl}/api/order ${
      invalidOnly ? "(deliberately invalid — nothing is emailed)" : `(receipt → ${receiptAddress})`
    }`,
  );
  const order = await request("/api/order", payload);
  console.log(`  ${order.status} (${order.ms}ms)`);
  console.log(`  ${show(order)}`);

  const body = typeof order.parsed === "object" && order.parsed ? order.parsed : {};
  if (order.status === 502) {
    console.log("\nMail delivery failed. On the server, look for a line shaped like:");
    console.log('  [mail] FAILED → <recipient> · "<subject>" · <reason>');
    console.log(
      body.detail
        ? `Reported reason: ${body.detail}`
        : "No detail field returned — the deployment predates the diagnostic build, or EXPOSE_ERROR_DETAILS=false.",
    );
  }

  process.exitCode = order.status >= 400 ? 1 : 0;
};

main().catch((error) => {
  console.error("probe failed to complete:", error);
  process.exitCode = 1;
});
