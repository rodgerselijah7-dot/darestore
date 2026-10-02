module.exports = (req, res) => {
  const o = (process.env.SITE_URL || `https://${req.headers.host}`).replace(/\/$/, "");
  res.setHeader("Content-Type", "text/plain");
  res.status(200).send(`User-agent: *\nDisallow: /api/\nDisallow: /admin\nDisallow: /success\nDisallow: /order\n\nSitemap: ${o}/sitemap.xml\n`);
};
