// Serves app.html (the storefront) with the right title, description, share image and structured data for each URL,
// so products show up properly in Google and in link previews (iMessage, Instagram, X).
const fs = require("fs");
const path = require("path");
const { catalog, find } = require("./_lib");
let TEMPLATE;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const INFO = { shipping: "Shipping", returns: "Returns & exchanges", size: "Size guide", faq: "FAQ", contact: "Contact", privacy: "Privacy", terms: "Terms" };
const CATS = { tops: "Tops", hoodies: "Hoodies", bottoms: "Bottoms", accessories: "Accessories" };

module.exports = (req, res) => {
  TEMPLATE = TEMPLATE || fs.readFileSync(path.join(process.cwd(), "app.html"), "utf8");
  const origin = (process.env.SITE_URL || `https://${req.headers.host}`).replace(/\/$/, "");
  const { r, id } = req.query || {};
  let title = "DARE", desc = "DARE — Desired Ambitions Required Execution. Clothing for people who act on what they want.";
  let image = `${origin}/images/og.png`, url = origin + "/", status = 200, ld = null, type = "website";

  if (r === "p") {
    const p = find(id);
    url = `${origin}/p/${encodeURIComponent(id || "")}`;
    if (!p) { status = 404; title = "Page not found | DARE"; }
    else {
      const out = p.soldOut || (p.stock && p.sizes.every(s => !p.stock[s]));
      title = `${p.name} | DARE`; desc = `${p.description} ${p.colorName}. $${p.price}.`;
      if (p.image) image = new URL(p.image, origin).href;
      type = "product";
      ld = { "@context": "https://schema.org", "@type": "Product", name: p.name, description: p.description, image: [image], sku: p.id, brand: { "@type": "Brand", name: "DARE" }, color: p.colorName,
        offers: { "@type": "Offer", url, priceCurrency: "USD", price: p.price.toFixed(2), availability: `https://schema.org/${out ? "SoldOut" : "InStock"}`, itemCondition: "https://schema.org/NewCondition" } };
    }
  } else if (r === "shop") { title = `${CATS[id] || "Shop"} | DARE`; url = `${origin}/shop/${encodeURIComponent(id || "")}`; if (!CATS[id]) status = 404; }
  else if (r === "info") { title = `${INFO[id] || "Info"} | DARE`; url = `${origin}/info/${encodeURIComponent(id || "")}`; if (!INFO[id]) status = 404; }
  else if (r === "about") { title = "About | DARE"; url = `${origin}/about`; }
  else if (r === "order") { title = "Order status | DARE"; url = `${origin}/order`; }
  else if (r === "success") { title = "Order confirmed | DARE"; url = `${origin}/success`; }

  const meta = `<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="${type}">
<meta property="og:site_name" content="DARE">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(image)}">
<meta name="twitter:card" content="summary_large_image">${r === "success" || r === "order" ? '\n<meta name="robots" content="noindex">' : ""}${ld ? `\n<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>` : ""}`;
  const html = TEMPLATE.replace(/<!--META-->[\s\S]*?<!--\/META-->/, `<!--META-->${meta}<!--/META-->`);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=600");
  res.status(status).send(html);
};
