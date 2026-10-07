// Admin API for /admin.html. Auth: header "Authorization: Bearer <ADMIN_PASSWORD>".
const crypto = require("crypto");
const { hasRedis, redis, stockTable, readJson, sendEmail, getCatalog, saveCatalog, storeImage, IMG_TYPES, clientIp, rateLimit } = require("./_lib");
const ok = h => { const pw = process.env.ADMIN_PASSWORD || ""; const got = String(h || "").replace(/^Bearer /, ""); return pw.length >= 8 && got.length === pw.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(pw)); };
const CARRIERS = { usps: n => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`, ups: n => `https://www.ups.com/track?tracknum=${n}`, fedex: n => `https://www.fedex.com/fedextrack/?trknbr=${n}`, dhl: n => `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${n}` };
const CATEGORIES = ["tops", "hoodies", "bottoms", "accessories"]; // keep in sync with CATS in api/page.js and the shop nav

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
    const catalog = await getCatalog({ all: true });
    const stock = await stockTable(catalog);
    const undo = +(await redis("LLEN", "catalog:history")) > 0 || !!(await redis("EXISTS", "catalog"));
    return res.status(200).json({ orders, stock, products: catalog.map(p => ({ ...p, tracked: !!p.stock })), categories: CATEGORIES, canUndo: undo, photoStore: process.env.BLOB_READ_WRITE_TOKEN ? "blob" : "redis" });
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
    const p = (await getCatalog({ all: true })).find(x => x.id === b.id);
    if (!p || !p.sizes.includes(b.size)) return res.status(400).json({ error: "Unknown product or size." });
    const avail = Math.max(0, parseInt(b.available, 10) || 0);
    const used = +(await redis("GET", `c:${p.id}:${b.size}`) || 0);
    await redis("SET", `st:${p.id}:${b.size}`, used + avail);
    return res.status(200).json({ stock: await stockTable() });
  }

  /* ---------- products ---------- */
  if (b.action === "upload") {
    const type = String(b.type || "");
    if (!IMG_TYPES[type]) return res.status(400).json({ error: "Use a JPG, PNG or WebP photo." });
    const buf = Buffer.from(String(b.data || ""), "base64");
    if (buf.length < 100) return res.status(400).json({ error: "That photo didn't come through. Try again." });
    if (buf.length > 3 * 1024 * 1024) return res.status(413).json({ error: "That photo is too large. Use one under 3 MB." });
    try { return res.status(200).json({ url: await storeImage(buf, type) }); }
    catch (e) { console.error(e); return res.status(502).json({ error: e.message }); }
  }
  if (b.action === "saveProduct") {
    const catalog = (await getCatalog({ all: true })).map(p => ({ ...p }));
    const isNew = !b.id;
    const old = isNew ? null : catalog.find(p => p.id === b.id);
    if (!isNew && !old) return res.status(404).json({ error: "That product no longer exists. Refresh and try again." });
    const v = clean(b.product || {});
    if (v.error) return res.status(400).json({ error: v.error });
    const p = v.product;
    p.id = isNew ? uniqueId(slug(`${p.name} ${p.colorName}`), catalog) : old.id;
    // Stock: sizes that already existed keep their counts (edit those in the Stock tab).
    // New sizes start at the number given in the form.
    const oldSizes = old ? old.sizes : [];
    const start = (b.product && b.product.startStock) || {};
    p.stock = {};
    for (const s of p.sizes) p.stock[s] = oldSizes.includes(s) && old.stock ? (old.stock[s] ?? 0) : Math.max(0, Math.min(99999, parseInt(start[s], 10) || 0));
    const added = p.sizes.filter(s => !oldSizes.includes(s));
    // a new (or re-added) size starts fresh, even if a deleted product once used the same id
    if (added.length) await redis("DEL", ...added.flatMap(s => [`st:${p.id}:${s}`, `c:${p.id}:${s}`]));
    if (isNew) catalog.push(p); else catalog[catalog.indexOf(old)] = p;
    await saveCatalog(catalog);
    return res.status(200).json({ product: p });
  }
  if (b.action === "hideProduct" || b.action === "deleteProduct" || b.action === "moveProduct") {
    const catalog = (await getCatalog({ all: true })).map(p => ({ ...p }));
    const i = catalog.findIndex(p => p.id === b.id);
    if (i < 0) return res.status(404).json({ error: "That product no longer exists. Refresh and try again." });
    if (b.action === "hideProduct") { if (b.hidden) catalog[i].hidden = true; else delete catalog[i].hidden; }
    if (b.action === "deleteProduct") catalog.splice(i, 1);
    if (b.action === "moveProduct") {
      const j = b.to === "top" ? 0 : i + (b.dir === "up" ? -1 : 1);
      if (j < 0 || j >= catalog.length || j === i) return res.status(200).json({ ok: true });
      const [p] = catalog.splice(i, 1); catalog.splice(j, 0, p);
    }
    await saveCatalog(catalog);
    return res.status(200).json({ ok: true });
  }
  if (b.action === "undoProducts") {
    const prev = await redis("LPOP", "catalog:history");
    if (prev) await redis("SET", "catalog", prev);
    else await redis("DEL", "catalog"); // back to products.json
    return res.status(200).json({ ok: true });
  }
  return res.status(400).json({ error: "Unknown action." });
};

/* ---------- product validation ---------- */
const str = (x, max) => String(x == null ? "" : x).replace(/\s+/g, " ").trim().slice(0, max);
const slug = s => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "piece";
function uniqueId(base, catalog) { let id = base, n = 2; while (catalog.some(p => p.id === id)) id = `${base}-${n++}`; return id; }
const okUrl = u => /^\/[^\s"'<>]*$/.test(u) || /^https:\/\/[^\s"'<>]+$/.test(u);
function clean(x) {
  const name = str(x.name, 80), colorName = str(x.colorName, 40), category = str(x.category, 20);
  if (!name) return { error: "Give the product a name." };
  if (!colorName) return { error: "Add a color, like Black or Washed Grey." };
  if (!CATEGORIES.includes(category)) return { error: "Pick a category." };
  const price = Math.round(parseFloat(String(x.price).replace(/[$,\s]/g, "")) * 100) / 100;
  if (!(price >= 0.5 && price <= 10000)) return { error: "Enter a price between $0.50 and $10,000." };
  const sizes = [...new Set((Array.isArray(x.sizes) ? x.sizes : String(x.sizes || "").split(",")).map(s => str(s, 12)).filter(Boolean))].slice(0, 12);
  if (!sizes.length) return { error: "Add at least one size. Use One Size for things like beanies." };
  const image = str(x.image, 500), imageBack = str(x.imageBack, 500);
  if (!image) return { error: "Add a front photo." };
  if (!okUrl(image) || (imageBack && !okUrl(imageBack))) return { error: "A photo link isn't valid. Upload the photo instead." };
  const description = str(x.description, 600);
  if (!description) return { error: "Add a short description." };
  const details = (Array.isArray(x.details) ? x.details : String(x.details || "").split("\n")).map(d => str(d, 100)).filter(Boolean).slice(0, 8);
  const badge = str(x.badge, 24);
  const p = { id: "", name, category, price, colorName, sizes, stock: {}, image };
  if (imageBack) p.imageBack = imageBack;
  p.description = description;
  p.details = details;
  if (badge) p.badge = badge;
  if (x.hidden) p.hidden = true;
  return { product: p };
}
