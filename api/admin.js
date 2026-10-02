// Admin API for /admin.html. Auth: header "Authorization: Bearer <ADMIN_PASSWORD>".
const crypto = require("crypto");
const { hasRedis, redis, stockTable, readJson, sendEmail, catalog, clientIp, rateLimit } = require("./_lib");
const ok = h => { const pw = process.env.ADMIN_PASSWORD || ""; const got = String(h || "").replace(/^Bearer /, ""); return pw.length >= 8 && got.length === pw.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(pw)); };
const CARRIERS = { usps: n => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`, ups: n => `https://www.ups.com/track?tracknum=${n}`, fedex: n => `https://www.fedex.com/fedextrack/?trknbr=${n}`, dhl: n => `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${n}` };

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!process.env.ADMIN_PASSWORD) return res.status(503).json({ error: "Set ADMIN_PASSWORD in Vercel (8+ characters) and redeploy." });
  if (!ok(req.headers.authorization)) {
    const limited = await rateLimit(`admin-fail:${clientIp(req)}`, 10, 900); // 10 wrong passwords per 15 minutes per IP
    if (!limited.ok) return res.status(429).json({ error: "Too many attempts. Wait 15 minutes and try again." });
    return res.status(401).json({ error: "Wrong password." });
  }
  if (!hasRedis()) return res.status(503).json({ error: "Connect an Upstash Redis database in Vercel (Storage) and redeploy." });

  if (req.method === "GET") {
    const refs = await redis("LRANGE", "orders", 0, 199);
    const raws = refs.length ? await redis("MGET", ...refs.map(r => `order:${r}`)) : [];
    const orders = raws.filter(r => r && r !== "pending").map(r => JSON.parse(r));
    const stock = await stockTable();
    return res.status(200).json({ orders, stock, products: catalog.map(p => ({ id: p.id, name: p.name, sizes: p.sizes, tracked: !!p.stock })) });
  }

  const b = await readJson(req);
  if (b.action === "ship" || b.action === "status") {
    const raw = await redis("GET", `order:${b.ref}`);
    if (!raw || raw === "pending") return res.status(404).json({ error: "Order not found." });
    const o = JSON.parse(raw);
    if (b.action === "ship") {
      const num = String(b.number || "").trim(), carrier = String(b.carrier || "usps").toLowerCase();
      o.status = "shipped";
      o.tracking = num ? { carrier, number: num, url: CARRIERS[carrier] ? CARRIERS[carrier](encodeURIComponent(num)) : "" } : null;
      o.shippedAt = new Date().toISOString();
      await redis("SET", `order:${o.ref}`, JSON.stringify(o));
      const sent = await sendEmail(o.email, `Your DARE order ${o.ref} has shipped`,
        `Hi ${o.name.split(" ")[0] || "there"},\n\nYour order ${o.ref} is on its way.\n\n${o.items.map(i => `${i.qty} x ${i.name}`).join("\n")}\n\n${o.tracking ? `Track it: ${o.tracking.url || o.tracking.number}\n\n` : ""}Thank you,\nDARE`);
      return res.status(200).json({ order: o, emailed: sent });
    }
    o.status = ["paid", "packing", "shipped", "delivered", "refunded", "cancelled"].includes(b.status) ? b.status : o.status;
    await redis("SET", `order:${o.ref}`, JSON.stringify(o));
    return res.status(200).json({ order: o });
  }
  if (b.action === "stock") {
    const p = catalog.find(x => x.id === b.id);
    if (!p || !p.sizes.includes(b.size)) return res.status(400).json({ error: "Unknown product or size." });
    const avail = Math.max(0, parseInt(b.available, 10) || 0);
    const used = +(await redis("GET", `c:${p.id}:${b.size}`) || 0);
    await redis("SET", `st:${p.id}:${b.size}`, used + avail);
    return res.status(200).json({ stock: await stockTable() });
  }
  return res.status(400).json({ error: "Unknown action." });
};
