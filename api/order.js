// Short order summary for the confirmation page (reads the Stripe session directly).
const { stripe, refOf } = require("./_lib");
module.exports = async (req, res) => {
  const id = String((req.query && req.query.session_id) || "");
  if (!/^cs_[A-Za-z0-9_]+$/.test(id) || !process.env.STRIPE_SECRET_KEY) return res.status(400).json({ error: "Order not found" });
  try {
    const s = await stripe("GET", `checkout/sessions/${id}?expand[]=line_items`);
    const ship = (s.collected_information && s.collected_information.shipping_details) || s.shipping_details || {};
    const email = (s.customer_details && s.customer_details.email) || "";
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      ref: refOf(id), paid: s.payment_status === "paid",
      name: (ship.name || (s.customer_details && s.customer_details.name) || "").split(" ")[0],
      email: email.replace(/^(.).*(@.*)$/, "$1•••$2"),
      total: (s.amount_total || 0) / 100,
      shipping: ((s.shipping_cost && s.shipping_cost.amount_total) || 0) / 100,
      items: ((s.line_items && s.line_items.data) || []).map(l => ({ name: l.description, qty: l.quantity, amount: l.amount_total / 100 }))
    });
  } catch { res.status(404).json({ error: "Order not found" }); }
};
