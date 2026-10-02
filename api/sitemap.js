const { catalog } = require("./_lib");
module.exports = (req, res) => {
  const o = (process.env.SITE_URL || `https://${req.headers.host}`).replace(/\/$/, "");
  const urls = ["/", "/about", "/shop/tops", "/shop/hoodies", "/shop/bottoms", "/shop/accessories", "/info/shipping", "/info/returns", "/info/size", "/info/faq", "/info/contact", ...catalog.map(p => `/p/${p.id}`)];
  res.setHeader("Content-Type", "application/xml");
  res.setHeader("Cache-Control", "public, s-maxage=3600");
  res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `  <url><loc>${o}${u}</loc></url>`).join("\n")}\n</urlset>`);
};
