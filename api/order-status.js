// Customer order lookup: POST { ref, email } -> status, items, tracking.
const { hasRedis, redis, readJson, clientIp, rateLimit } = require("./_lib");
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();
  const limited = await rateLimit(`orderstatus:${clientIp(req)}`, 20, 3600); // 20 lookups per hour per IP
  if (!limited.ok) return res.status(429).json({ error: "Too many attempts. Wait a while and try again, or email us." });
  const { ref, email } = await readJson(req);
  const clean = String(ref || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(-8);
  if (!clean || !email) return res.status(400).json({ error: "Enter your order number and the email you used at checkout." });
  if (!hasRedis()) return res.status(503).json({ error: "Order lookup isn't available yet. Email us and we'll check for you." });
  const raw = await redis("GET", `order:${clean}`);
  const o = raw && raw !== "pending" && JSON.parse(raw);
  if (!o || o.email.toLowerCase() !== String(email).trim().toLowerCase())
    return res.status(404).json({ error: "We couldn't find that order. Check the number in your receipt email and the email address you used." });
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ ref: o.ref, created: o.created, status: o.status, items: o.items, total: o.total, tracking: o.tracking, city: o.address && [o.address.city, o.address.state].filter(Boolean).join(", ") });
};
