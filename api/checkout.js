// Creates a Stripe Checkout session and holds the stock for 30 minutes while the customer pays.
// Env: STRIPE_SECRET_KEY (required). Stock holds need Upstash Redis (KV_REST_API_URL / KV_REST_API_TOKEN).
const { find, stockTable, reserve, release, packRes, stripe, readJson, hasRedis, redis, clientIp, rateLimit } = require("./_lib");

const FREE_SHIPPING_OVER = 100; // dollars; keep in sync with CONFIG.freeShippingOver in index.html
const RATES = {
  standard: { name: "Standard shipping", cents: 800, min: 5, max: 7 },
  express: { name: "Express shipping", cents: 1800, min: 2, max: 3 }
};
const rate = (r, cents, name) => ({ shipping_rate_data: {
  type: "fixed_amount", display_name: name || r.name, fixed_amount: { amount: cents, currency: "usd" },
  delivery_estimate: { minimum: { unit: "business_day", value: r.min }, maximum: { unit: "business_day", value: r.max } }
}});

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: "Checkout isn't set up yet. Add STRIPE_SECRET_KEY in Vercel and redeploy." });
  const limited = await rateLimit(`checkout:${clientIp(req)}`, 20, 600); // 20 checkout attempts per 10 minutes per IP
  if (!limited.ok) return res.status(429).json({ error: "Too many checkout attempts. Wait a few minutes and try again." });

  const body = await readJson(req);
  const raw = Array.isArray(body.items) ? body.items.slice(0, 25) : [];
  if (!raw.length) return res.status(400).json({ error: "Your bag is empty." });

  // merge duplicate lines and validate against the catalog
  const merged = new Map();
  for (const it of raw) {
    const p = find(it.id);
    if (!p) return res.status(400).json({ error: "A piece in your bag is no longer available. Remove it and try again." });
    if (!p.sizes.includes(it.size)) return res.status(400).json({ error: `${p.name} doesn't come in size ${it.size}.` });
    if (p.soldOut) return res.status(400).json({ error: `${p.name} is sold out. Remove it and try again.` });
    const key = p.id + "|" + it.size;
    const qty = Math.max(1, Math.min(10, parseInt(it.qty, 10) || 1));
    merged.set(key, { p, size: it.size, qty: Math.min(10, (merged.get(key)?.qty || 0) + qty) });
  }
  const lines = [...merged.values()];

  // hold stock atomically so two people can't buy the last one
  const table = await stockTable().catch(() => ({}));
  const tracked = lines.filter(l => l.p.stock).map(l => ({ id: l.p.id, size: l.size, qty: l.qty, stock: table[l.p.id]?.[l.size]?.total ?? l.p.stock[l.size] ?? 0 }));
  if (!hasRedis()) {
    const out = tracked.find(t => t.qty > (t.stock || 0));
    if (out) return res.status(409).json({ error: `${find(out.id).name} in size ${out.size} is sold out. Remove it and try again.` });
  }
  let failed;
  try { failed = await reserve(tracked); } catch (e) { console.error(e); return res.status(503).json({ error: "The shop is busy. Try again in a moment." }); }
  if (failed) {
    const t = tracked[failed - 1], left = table[t.id]?.[t.size]?.available ?? 0;
    return res.status(409).json({ error: left > 0 ? `Only ${left} left of ${find(t.id).name} in size ${t.size}. Lower the quantity and try again.` : `${find(t.id).name} in size ${t.size} just sold out. Remove it and try again.` });
  }

  const origin = req.headers.origin || `https://${req.headers.host}`;
  const subtotal = lines.reduce((a, l) => a + l.p.price * l.qty, 0);
  const free = subtotal >= FREE_SHIPPING_OVER;
  try {
    const session = await stripe("POST", "checkout/sessions", {
      mode: "payment",
      line_items: lines.map(l => ({ quantity: l.qty, price_data: { currency: "usd", unit_amount: Math.round(l.p.price * 100), product_data: {
        name: `${l.p.name} (${l.p.colorName}, ${l.size})`,
        images: l.p.image ? [new URL(l.p.image, origin).href] : undefined,
        metadata: { product_id: l.p.id, size: l.size } } } })),
      shipping_options: [free ? rate(RATES.standard, 0, "Free standard shipping") : rate(RATES.standard, RATES.standard.cents), rate(RATES.express, RATES.express.cents)],
      shipping_address_collection: { allowed_countries: ["US"] },
      phone_number_collection: { enabled: true },
      billing_address_collection: "auto",
      customer_creation: "always",
      allow_promotion_codes: true,
      automatic_tax: { enabled: process.env.STRIPE_AUTOMATIC_TAX === "true" },
      expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
      success_url: `${origin}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?bag=open`,
      metadata: { res: packRes(tracked).slice(0, 499), cart: lines.map(l => `${l.p.id}|${l.size}|${l.qty}`).join(",").slice(0, 499) }
    });
    if (hasRedis() && tracked.length) await redis("SET", `res:${session.id}`, JSON.stringify(tracked), "EX", 7200).catch(() => {});
    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error("Stripe error", e.stripe || e);
    await release(tracked).catch(() => {});
    return res.status(502).json({ error: "Checkout couldn't start. Try again in a minute." });
  }
};
