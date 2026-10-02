// TEMPORARY diagnostic endpoint. Reports presence/success only, never secret values \u2014
// safe to leave up short-term, but delete this file once Redis is confirmed working.
const { hasRedis, redis } = require("./_lib");
module.exports = async (req, res) => {
  const seen = {
    UPSTASH_REDIS_REST_URL: !!process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: !!process.env.UPSTASH_REDIS_REST_TOKEN,
    KV_REST_API_URL: !!process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: !!process.env.KV_REST_API_TOKEN,
  };
  const urlPreview = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "(none set)").slice(0, 40);
  const out = { envVarsPresent: seen, hasRedisResult: hasRedis(), urlPreview };
  if (hasRedis()) {
    try {
      const result = await redis("SET", "debug:ping", String(Date.now()));
      out.liveWriteTest = { ok: true, result };
    } catch (e) {
      out.liveWriteTest = { ok: false, error: String((e && e.message) || e) };
    }
  } else {
    out.liveWriteTest = { ok: false, error: "skipped \u2014 hasRedis() returned false, so no network call was attempted" };
  }
  res.status(200).json(out);
};
