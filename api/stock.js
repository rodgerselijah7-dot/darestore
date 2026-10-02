// Live availability for the storefront: { products: { id: { size: available } } }
const { stockTable } = require("./_lib");
module.exports = async (req, res) => {
  try {
    const t = await stockTable();
    const products = {};
    for (const [id, sizes] of Object.entries(t)) { products[id] = {}; for (const [s, v] of Object.entries(sizes)) products[id][s] = v.available; }
    res.setHeader("Cache-Control", "public, s-maxage=5, stale-while-revalidate=10");
    res.status(200).json({ products });
  } catch (e) { console.error(e); res.status(200).json({ products: {} }); }
};
