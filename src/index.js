/**
 * 91 video —— 全局「被骗」计数器后端
 *
 * 运行时：Cloudflare Workers（ES Module 语法）
 * 存储：Workers KV，绑定名固定为 COUNTER_KV（见 wrangler.toml）
 * 依赖：0 个第三方包，只用平台原生 API
 *
 * 接口：
 *   POST /api/hit    -> { "count": N }   计数 +1，返回最新值
 *   GET  /api/count  -> { "count": N }   只读当前值，不增加计数
 *   OPTIONS /任意路径 -> 204             CORS 预检
 *   GET  /           -> 服务说明
 *
 * 设计取舍：
 *   - KV 是最终一致存储，没有原子自增；高并发下可能少量漏计，作为整活项目可接受。
 *   - 限流同样基于 KV，属于「尽力而为」，不是强一致的安全边界。
 *   - 所有外部输入与 KV 内容都按脏数据处理，绝不把 NaN / 字符串带进返回值。
 */

const COUNT_KEY = 'global_count';          // 全局计数器键
const RL_PREFIX = 'rl:';                   // 限流记录键前缀
const RL_WINDOW = 60;                      // 限流窗口（秒）；KV expirationTtl 最小值为 60
const RL_MAX = 5;                          // 单 IP 每窗口最多允许的 hit 次数
const COUNT_MAX = Number.MAX_SAFE_INTEGER - 1;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

/** 统一 JSON 响应：始终带 CORS 头，禁用缓存避免计数被 CDN 缓存住 */
function json(body, status, extraHeaders) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  for (const [k, v] of Object.entries(extraHeaders || {})) headers.set(k, v);
  return new Response(JSON.stringify(body), { status: status || 200, headers });
}

/** OPTIONS 预检：无响应体，204 + CORS 头 */
function preflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** 取客户端 IP。CF-Connecting-IP 由 Cloudflare 注入，可信；否则回落到 XFF */
function clientIp(request) {
  const cf = request.headers.get('CF-Connecting-IP');
  if (cf) return cf.trim();
  const xff = request.headers.get('X-Forwarded-For');
  if (xff) return xff.split(',')[0].trim();
  return 'unknown';
}

/** FNV-1a 哈希：KV 里只存 IP 哈希，不存原始 IP */
function hashIp(ip) {
  let h = 0x811c9dc5;
  for (let i = 0; i < ip.length; i++) {
    h ^= ip.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 脏数据容错：只接受纯数字字符串且落在安全整数范围内。
 * 出现 null / 乱码 / 负数 / 溢出，一律按 0 处理，避免 NaN 写回 KV。
 */
function sanitizeCount(raw) {
  if (raw === null || raw === undefined) return 0;
  const s = String(raw).trim();
  if (!/^\d{1,16}$/.test(s)) return 0;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 0 || n >= COUNT_MAX) return 0;
  return n;
}

/**
 * 简单 IP 限流：单 IP 在 60 秒窗口内最多 RL_MAX 次 hit。
 * 记录格式 { count, resetAt }，用 expirationTtl 自动过期，无需清理任务。
 * 注：KV 最终一致 + 写入不阻塞响应，因此这是尽力而为的限流。
 */
async function checkRateLimit(kv, ip, ctx) {
  const key = RL_PREFIX + hashIp(ip);
  const now = Date.now();

  let rec = null;
  try {
    rec = await kv.get(key, 'json');
  } catch (e) {
    rec = null; // 读取失败时放行，不让限流自身拖垮接口
  }

  let count = 0;
  let resetAt = 0;
  if (rec && typeof rec === 'object' && !Array.isArray(rec)) {
    count = Number.isSafeInteger(rec.count) && rec.count >= 0 ? rec.count : 0;
    resetAt = Number.isFinite(rec.resetAt) ? rec.resetAt : 0;
  }
  if (now >= resetAt) {
    count = 0;
    resetAt = now + RL_WINDOW * 1000;
  }
  if (count >= RL_MAX) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((resetAt - now) / 1000)) };
  }

  const next = { count: count + 1, resetAt };
  try {
    const write = kv.put(key, JSON.stringify(next), { expirationTtl: RL_WINDOW }).catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(write);
  } catch (e) {
    // 限流写入失败不影响主流程
  }
  return { ok: true };
}

/** POST /api/hit：限流 -> 读 -> +1 -> 写 -> 返回新值 */
async function handleHit(request, env, ctx) {
  const kv = env.COUNTER_KV;
  if (!kv) return json({ error: 'KV 绑定 COUNTER_KV 缺失，请检查 wrangler.toml' }, 500);

  const rl = await checkRateLimit(kv, clientIp(request), ctx);
  if (!rl.ok) {
    return json(
      { error: '请求过于频繁，请稍后再试' },
      429,
      { 'Retry-After': String(rl.retryAfter) }
    );
  }

  let raw;
  try {
    raw = await kv.get(COUNT_KEY);
  } catch (e) {
    return json({ error: '计数读取失败，请稍后重试' }, 503);
  }

  const next = sanitizeCount(raw) + 1;
  try {
    await kv.put(COUNT_KEY, String(next));
  } catch (e) {
    return json({ error: '计数写入失败，请稍后重试' }, 503);
  }
  return json({ count: next });
}

/** GET /api/count：只读，不触发限流，不增加计数 */
async function handleCount(env) {
  const kv = env.COUNTER_KV;
  if (!kv) return json({ error: 'KV 绑定 COUNTER_KV 缺失，请检查 wrangler.toml' }, 500);

  let raw;
  try {
    raw = await kv.get(COUNT_KEY);
  } catch (e) {
    return json({ error: '计数读取失败，请稍后重试' }, 503);
  }
  return json({ count: sanitizeCount(raw) });
}

export default {
  async fetch(request, env, ctx) {
    // 预检请求必须最先处理，且不要求 KV 可用
    if (request.method === 'OPTIONS') return preflight();

    try {
      const { pathname } = new URL(request.url);

      if (pathname === '/api/hit' && request.method === 'POST') {
        return await handleHit(request, env, ctx);
      }
      if (pathname === '/api/count' && request.method === 'GET') {
        return await handleCount(env);
      }
      if (pathname === '/api/hit' || pathname === '/api/count') {
        return json({ error: '方法不允许' }, 405, { 'Allow': 'GET, POST, OPTIONS' });
      }
      if (pathname === '/' && request.method === 'GET') {
        return json({
          service: '91 video counter',
          endpoints: ['POST /api/hit', 'GET /api/count'],
        });
      }
      return json({ error: 'Not Found' }, 404);
    } catch (e) {
      // 兜底：任何未捕获异常都返回带 CORS 头的 JSON，前端不会卡在跨域错误上
      return json({ error: '服务内部错误，请稍后重试' }, 500);
    }
  },
};
