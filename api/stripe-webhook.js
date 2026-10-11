// Stripe webhook: logs paid orders and releases stock held by abandoned checkouts.
// Stripe Dashboard > Developers > Webhooks > Add endpoint: https://YOUR-SITE/api/stripe-webhook
// Events: checkout.session.completed, checkout.session.expired. Env: STRIPE_WEBHOOK_SECRET.
const { verifyStripe, readRaw, readJson, hasRedis, redis, release, unpackRes, stripe, sendEmail, refOf, SITE } = require("./_lib");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();
  const raw = await readRaw(req);
      let event;
    if (verifyStripe(raw, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET)) {
      event = JSON.parse(raw);
    } else {
      // Vercel pre-parses JSON bodies, which breaks the signature check.
      // Fall back to fetching the event straight from Stripe (authoritative).
      const body = await readJson(req);
      const id = body && body.id;
      if (!id || !String(id).startsWith("evt_")) return res.status(400).end();
      try { event = await stripe("GET", `events/${id}`); }
      catch { return res.status(400).end(); }
    }
  const s = event.data && event.data.object;
  try {
    if (event.type === "checkout.session.expired" && hasRedis()) {
      // release the hold once, even if Stripe retries
      if (await redis("SET", `rel:${s.id}`, "1", "NX", "EX", 604800)) await release(unpackRes(s.metadata && s.metadata.res));
    }
    if (event.type === "checkout.session.completed") {
      const full = await stripe("GET", `checkout/sessions/${s.id}?expand[]=line_items`);
      const ship = (full.collected_information && full.collected_information.shipping_details) || full.shipping_details || {};
      const cust = full.customer_details || {};
      const order = {
        ref: refOf(s.id), session: s.id, created: new Date(full.created * 1000).toISOString(), status: "paid",
        email: cust.email || "", name: ship.name || cust.name || "", phone: cust.phone || "",
        address: ship.address || null,
        items: ((full.line_items && full.line_items.data) || []).map(l => ({ name: l.description, qty: l.quantity, amount: l.amount_total / 100 })),
        shipping: ((full.shipping_cost && full.shipping_cost.amount_total) || 0) / 100,
        total: (full.amount_total || 0) / 100, tracking: null
      };
      if (hasRedis() && await redis("SET", `order:${order.ref}`, JSON.stringify(order), "NX")) {
        await redis("LPUSH", "orders", order.ref);
        await sendEmail(process.env.OWNER_EMAIL, `New order ${order.ref}: $${order.total.toFixed(2)}`,
          `${order.name} (${order.email})\n\n${order.items.map(i => `${i.qty} x ${i.name}  $${i.amount.toFixed(2)}`).join("\n")}\n\nShipping: $${order.shipping.toFixed(2)}\nTotal: $${order.total.toFixed(2)}\n\nShip to:\n${fmtAddr(order)}\n\nManage: ${SITE()}/admin`);
      }
    }
    return res.status(200).json({ received: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Webhook failed" }); // Stripe will retry
  }
};
function fmtAddr(o) {
  const a = o.address || {};
  return [o.name, a.line1, a.line2, [a.city, a.state, a.postal_code].filter(Boolean).join(" "), a.country].filter(Boolean).join("\n");
}
module.exports.config = { api: { bodyParser: false } };
