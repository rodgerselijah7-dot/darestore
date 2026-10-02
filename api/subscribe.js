// Sends the "10% off" welcome email when someone joins the list. Optional — the signup itself
// goes straight to Klaviyo from the browser; this just adds an immediate, on-brand email via Resend
// so new subscribers get their code right away, even before a Klaviyo welcome flow exists.
// Env: RESEND_API_KEY, FROM_EMAIL. Reads the code from products.json's sibling config? No —
// keep the code in sync with CONFIG.welcomeCode in app.html; it's duplicated here on purpose so
// this file has no dependency on the client bundle.
const { readJson, clientIp, rateLimit, sendEmail } = require("./_lib");

const WELCOME_CODE = "WELCOME10"; // keep this the same as CONFIG.welcomeCode in app.html

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();
  const limited = await rateLimit(`subscribe:${clientIp(req)}`, 8, 3600); // 8 signups per hour per IP
  if (!limited.ok) return res.status(429).json({ ok: false });
  const { email } = await readJson(req);
  const clean = String(email || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) return res.status(200).json({ ok: false }); // fail quietly, never blocks the signup UX
  await sendEmail(clean, "10% off your first DARE order",
    `You're on the list.\n\nUse the code ${WELCOME_CODE} for 10% off your first order — just enter it at checkout.\n\nWe'll email you when new pieces land.\n\nDARE`
  ).catch(() => {});
  return res.status(200).json({ ok: true });
};
