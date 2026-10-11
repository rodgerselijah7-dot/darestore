// Shared helpers for the API functions. Files starting with "_" are not exposed as routes.
const crypto = require("crypto");
const BASE_CATALOG = require("../products.json");
const GAMES = require("../games.json"); // DARE Arcade games, sold as digital products

const SITE = () => (process.env.SITE_URL || "").replace(/\/$/, "");

/* ---------- Upstash Redis over REST (Vercel Marketplace > Upstash / KV) ---------- */
const R_URL = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const R_TOKEN = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const hasRedis = () => !!(R_URL() && R_TOKEN());
async function redis(...cmd) {
  const r = await fetch(R_URL(), { method: "POST", headers: { Authorization: `Bearer ${R_TOKEN()}`, "Content-Type": "application/json" }, body: JSON.stringify(cmd.map(String)) });
  const d = await r.json();
  if (d.error) throw new Error("Redis: " + d.error);
  return d.result;
}

/* ---------- catalog ----------
   Products live in Redis under "catalog" once they've been edited from the admin page.
   Until then (or if Redis is down) the store uses products.json. Hidden products stay in the
   catalog (so old orders and stock still line up) but aren't shown or sold. */
const CAT_KEY = "catalog";
async function getCatalog({ all = false } = {}) {
  let list = BASE_CATALOG;
  if (hasRedis()) {
    try { const raw = await redis("GET", CAT_KEY); if (raw) list = JSON.parse(raw); }
    catch (e) { console.error("catalog read failed, using products.json", e); }
  }
  return all ? list : list.filter(p => !p.hidden);
}
async function saveCatalog(list) {
  const prev = await redis("GET", CAT_KEY);
  if (prev) { await redis("LPUSH", "catalog:history", prev); await redis("LTRIM", "catalog:history", 0, 19); }
  await redis("SET", CAT_KEY, JSON.stringify(list));
}
async function find(id, opts) { return (await getCatalog(opts)).find(p => p.id === id); }
// What the storefront sells: the clothing catalog (admin-editable) plus the arcade games from games.json.
// Games are kept out of getCatalog so the admin page never edits or saves them; change game prices in games.json.
async function shopCatalog(opts) {
  const clothes = await getCatalog(opts);
  return [...clothes.filter(p => !GAMES.some(g => g.id === p.id)), ...GAMES];
}

/* ---------- arcade game unlocks ----------
   lic:<CODE>          { email, games: [...], sessions: [...], created }
   lic-email:<email>   CODE   (one code per customer; later purchases add games to it)
   lic-sess:<session>  CODE   (makes granting idempotent across webhook retries and the success page) */
const ARCADE = () => (process.env.ARCADE_URL || "https://dare-arcade.vercel.app").replace(/\/$/, "");
const ARCADE_ORIGINS = () => (process.env.ARCADE_ORIGINS || "https://dare-arcade.vercel.app,https://games.darewear.store").split(",").map(s => s.trim()).filter(Boolean);
const CODE_ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I, so codes are easy to type
const newCode = () => [...crypto.randomBytes(12)].map(b => CODE_ABC[b % 32]).join("");
const cleanCode = c => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const isCode = c => c.length === 12 && [...c].every(ch => CODE_ABC.includes(ch));
const fmtCode = c => c.replace(/(.{4})(?=.)/g, "$1-");
// "game-ori|Digital|1,tee-black|M|2" (session metadata.cart) -> ["ori"]
function gamesInCart(cartMeta) {
  const ids = String(cartMeta || "").split(",").map(x => x.split("|")[0]).filter(Boolean);
  return [...new Set(ids.flatMap(id => { const g = GAMES.find(x => x.id === id); return g ? (g.games || [g.game]) : []; }))];
}
async function grantGames(sessionId, email, games) {
  if (!hasRedis() || !games.length || !sessionId) return null;
  const done = await redis("GET", `lic-sess:${sessionId}`);
  if (done) return { code: done, first: false };
  const em = String(email || "").trim().toLowerCase();
  let code = em && await redis("GET", `lic-email:${em}`);
  if (!code) code = newCode();
  // claim this session first so a webhook retry racing the success page can't email twice
  const claimed = await redis("SET", `lic-sess:${sessionId}`, code, "NX");
  if (!claimed) return { code: await redis("GET", `lic-sess:${sessionId}`), first: false };
  const raw = await redis("GET", `lic:${code}`);
  const lic = raw ? JSON.parse(raw) : { email: em, games: [], sessions: [], created: new Date().toISOString() };
  lic.games = [...new Set([...lic.games, ...games])];
  lic.sessions = [...new Set([...(lic.sessions || []), sessionId])].slice(-50);
  await redis("SET", `lic:${code}`, JSON.stringify(lic));
  if (em) await redis("SET", `lic-email:${em}`, code);
  return { code, first: true, games: lic.games };
}
async function licenseGames(code) {
  if (!hasRedis() || !isCode(code)) return null;
  const raw = await redis("GET", `lic:${code}`);
  return raw ? JSON.parse(raw).games || [] : null;
}
function playLink(code, games) {
  const one = games.length === 1 ? `/${games[0]}/` : "/";
  return `${ARCADE()}${one}?unlock=${code}`;
}
function unlockEmail(code, games) {
  const names = games.map(g => (GAMES.find(x => x.game === g) || {}).name || g).join(", ");
  return `Your DARE Arcade games are unlocked: ${names}.\n\nPlay now: ${playLink(code, games)}\n\nYour unlock code: ${fmtCode(code)}\n\nOn another phone or computer, or in the arcade app on your Home Screen, open a game and tap "Enter unlock code". Keep this email; the code works for every game you buy with this email address.\n\nDesired Ambitions Requires Execution.`;
}

/* ---------- stock ----------
   c:<id>:<size>  units committed (paid orders + checkouts in progress)
   st:<id>:<size> stock override set from the admin page (falls back to products.json) */
const ck = (id, size) => `c:${id}:${size}`;
const sk = (id, size) => `st:${id}:${size}`;
async function stockTable(list) {
  const catalog = list || await getCatalog({ all: true });
  const rows = [];
  for (const p of catalog) if (p.stock) for (const s of p.sizes) rows.push([p, s]);
  let committed = [], overrides = [];
  if (hasRedis() && rows.length) {
    committed = await redis("MGET", ...rows.map(([p, s]) => ck(p.id, s)));
    overrides = await redis("MGET", ...rows.map(([p, s]) => sk(p.id, s)));
  }
  const out = {};
  rows.forEach(([p, s], i) => {
    const total = overrides[i] != null ? +overrides[i] : +(p.stock[s] || 0);
    const used = +(committed[i] || 0);
    (out[p.id] = out[p.id] || {})[s] = { total, committed: used, available: Math.max(0, total - used) };
  });
  return out;
}
const RESERVE = `
for i=1,#KEYS do
  local used = tonumber(redis.call('GET', KEYS[i]) or '0')
  local total = tonumber(redis.call('GET', 'st:' .. string.sub(KEYS[i], 3)) or ARGV[2*i])
  if used + tonumber(ARGV[2*i-1]) > total then return i end
end
for i=1,#KEYS do redis.call('INCRBY', KEYS[i], ARGV[2*i-1]) end
return 0`;
// lines: [{id,size,qty,stock}] for items that track stock. Returns 0 on success, or the 1-based index that ran out.
async function reserve(lines) {
  if (!hasRedis() || !lines.length) return 0;
  return +(await redis("EVAL", RESERVE, lines.length, ...lines.map(l => ck(l.id, l.size)), ...lines.flatMap(l => [l.qty, l.stock])));
}
async function release(lines) {
  if (!hasRedis()) return;
  for (const l of lines) await redis("DECRBY", ck(l.id, l.size), l.qty);
}
const packRes = lines => lines.map(l => `${l.id}|${l.size}|${l.qty}`).join(",");
const unpackRes = s => (s || "").split(",").filter(Boolean).map(x => { const [id, size, qty] = x.split("|"); return { id, size, qty: +qty }; });

/* ---------- Stripe over REST ---------- */
function form(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") form(v, key, out); else out.push(encodeURIComponent(key) + "=" + encodeURIComponent(v));
  }
  return out.join("&");
}
async function stripe(method, path, params) {
  const r = await fetch("https://api.stripe.com/v1/" + path, {
    method, headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params ? form(params) : undefined
  });
  const d = await r.json();
  if (!r.ok) { const e = new Error((d.error && d.error.message) || "Stripe error"); e.stripe = d.error; throw e; }
  return d;
}
function verifyStripe(raw, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(",").map(x => x.split("=")).map(([k, ...v]) => [k, v.join("=")]));
  const sigs = header.split(",").filter(x => x.startsWith("v1=")).map(x => x.slice(3));
  const t = +parts.t;
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return sigs.some(s => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

/* ---------- email (optional, via Resend) ---------- */
async function sendEmail(to, subject, text) {
  if (!process.env.RESEND_API_KEY || !to) return false;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.FROM_EMAIL || "DARE <orders@resend.dev>", to, subject, text })
  });
  return r.ok;
}

/* ---------- product photos ----------
   With a Vercel Blob store connected (BLOB_READ_WRITE_TOKEN), photos go there.
   Without one, they're kept in Redis and served by /api/img, cached at the edge for a year.
   Either way the key is a hash of the file, so the same photo is never stored twice. */
const IMG_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
async function storeImage(buf, type) {
  const ext = IMG_TYPES[type];
  if (!ext) throw new Error("Use a JPG, PNG or WebP photo.");
  const key = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 24) + "." + ext;
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (token) {
    const r = await fetch("https://vercel.com/api/blob/?" + new URLSearchParams({ pathname: "products/" + key }), {
      method: "PUT", body: buf,
      headers: { authorization: `Bearer ${token}`, "x-api-version": "12", "x-vercel-blob-store-id": token.split("_")[3] || "",
        "x-vercel-blob-access": "public", "x-content-type": type, "x-add-random-suffix": "0", "x-allow-overwrite": "1" }
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.url) throw new Error("Photo upload failed" + (d.error && d.error.message ? `: ${d.error.message}` : "."));
    return d.url;
  }
  if (!hasRedis()) throw new Error("Connect Upstash Redis (or a Vercel Blob store) to upload photos.");
  await redis("SET", "img:" + key, buf.toString("base64"));
  return "/api/img?k=" + key;
}

/* ---------- misc ---------- */
async function readRaw(req) {
  if (typeof req.body === "string") return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  const chunks = []; for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}
async function readJson(req) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
  try { return JSON.parse(await readRaw(req) || "{}"); } catch { return {}; }
}
const refOf = sessionId => sessionId.slice(-8).toUpperCase();

/* ---------- rate limiting ----------
   Fixed window per key (e.g. "ip:1.2.3.4"). Fails open (allows the request) if Redis isn't set up,
   so a missing database never blocks real customers — it just removes the abuse guard. */
const clientIp = req => String(((req.headers || {})["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress || "unknown");
async function rateLimit(key, limit, windowSeconds) {
  if (!hasRedis()) return { ok: true };
  const k = `rl:${key}:${Math.floor(Date.now() / 1000 / windowSeconds)}`;
  const n = await redis("INCR", k);
  if (n === 1) await redis("EXPIRE", k, windowSeconds);
  return { ok: n <= limit, remaining: Math.max(0, limit - n) };
}

module.exports = { GAMES, shopCatalog, ARCADE, ARCADE_ORIGINS, cleanCode, isCode, fmtCode, gamesInCart, grantGames, licenseGames, playLink, unlockEmail, storeImage, IMG_TYPES, BASE_CATALOG, getCatalog, saveCatalog, find, SITE, hasRedis, readJson, redis, stockTable, reserve, release, packRes, unpackRes, stripe, verifyStripe, sendEmail, readRaw, readJson, refOf, clientIp, rateLimit };
