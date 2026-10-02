// Shared helpers for the API functions. Files starting with "_" are not exposed as routes.
const crypto = require("crypto");
const catalog = require("../products.json");

const SITE = () => (process.env.SITE_URL || "").replace(/\/$/, "");
const find = id => catalog.find(p => p.id === id);

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

/* ---------- stock ----------
   c:<id>:<size>  units committed (paid orders + checkouts in progress)
   st:<id>:<size> stock override set from the admin page (falls back to products.json) */
const ck = (id, size) => `c:${id}:${size}`;
const sk = (id, size) => `st:${id}:${size}`;
async function stockTable() {
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

module.exports = { catalog, find, SITE, hasRedis, redis, stockTable, reserve, release, packRes, unpackRes, stripe, verifyStripe, sendEmail, readRaw, readJson, refOf, clientIp, rateLimit };
