// The live product list (admin edits included, hidden products left out).
// Storefront pages get this inlined by api/page.js; this endpoint is the fallback.
const { getCatalog } = require("./_lib");
module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=300");
  res.status(200).json(await getCatalog());
};
