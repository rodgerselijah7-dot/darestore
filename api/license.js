// DARE Arcade unlocks, called from the arcade site (a different domain, so CORS is allowed for it).
//   GET  /api/license?code=ABCD-EFGH-JKLM  -> { games: ["ori", ...] }   (404 if the code doesn't exist)
//   POST /api/license { email }            -> emails the customer their code and play link, if they've bought games
// Env (optional): ARCADE_URL (default https://dare-arcade.vercel.app), ARCADE_ORIGINS (comma-separated).
const { hasRedis, redis, readJson, clientIp, rateLimit, cleanCode, isCode, licenseGames, sendEmail, unlockEmail, ARCADE_ORIGINS } = require("./_lib");

function cors(req, res) {
  const origin = (req.headers || {}).origin;
  if (origin && ARCADE_ORIGINS().includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
}

module.exports = async (req, res) => {
  cors(req, res);
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!hasRedis()) return res.status(503).json({ error: "Unlocks aren't available right now. Try again later." });

  if (req.method === "GET") {
    const limited = await rateLimit(`lic:${clientIp(req)}`, 60, 600); // 60 checks per 10 minutes per IP
    if (!limited.ok) return res.status(429).json({ error: "Too many tries. Wait a few minutes and try again." });
    const code = cleanCode(req.query && req.query.code);
    if (!isCode(code)) return res.status(400).json({ error: "That code doesn't look right. It's 12 letters and numbers, like ABCD-EFGH-JKLM." });
    const games = await licenseGames(code);
    if (!games) return res.status(404).json({ error: "We couldn't find that code. Check it against your receipt email." });
    return res.status(200).json({ games });
  }

  if (req.method === "POST") {
    const limited = await rateLimit(`licmail:${clientIp(req)}`, 5, 3600); // 5 restore emails per hour per IP
    if (!limited.ok) return res.status(429).json({ error: "Too many tries. Wait a while and try again." });
    const { email } = await readJson(req);
    const em = String(email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return res.status(400).json({ error: "Enter the email you used at checkout." });
    if (!process.env.RESEND_API_KEY) return res.status(503).json({ error: "Email restore isn't set up yet. Use the unlock code on your order confirmation, or contact us." });
    const code = await redis("GET", `lic-email:${em}`);
    if (code) {
      const games = await licenseGames(code);
      if (games && games.length) await sendEmail(em, "Your DARE Arcade unlock code", unlockEmail(code, games)).catch(() => {});
    }
    // same answer either way, so this can't be used to check who has bought what
    return res.status(200).json({ ok: true, message: "If that email has bought games, we've sent the unlock code to it." });
  }
  return res.status(405).json({ error: "Method not allowed" });
};
