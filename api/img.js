// Serves product photos uploaded from the admin page when no Vercel Blob store is connected.
// Keys are content hashes, so a URL never changes what it points to and can be cached for a year.
const { hasRedis, redis, IMG_TYPES } = require("./_lib");
const MIME = Object.fromEntries(Object.entries(IMG_TYPES).map(([m, e]) => [e, m]));
module.exports = async (req, res) => {
  const k = String((req.query && req.query.k) || "");
  const m = /^[a-f0-9]{24}\.(jpg|png|webp)$/.exec(k);
  if (!m || !hasRedis()) return res.status(404).end();
  const b64 = await redis("GET", "img:" + k).catch(() => null);
  if (!b64) return res.status(404).end();
  res.setHeader("Content-Type", MIME[m[1]]);
  res.setHeader("Cache-Control", "public, max-age=31536000, s-maxage=31536000, immutable");
  res.status(200).send(Buffer.from(b64, "base64"));
};
