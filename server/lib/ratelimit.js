import { HttpError } from './http.js';

/**
 * In-memory fixed-window rate limiter. Suitable for a single-node MVP; swap for a
 * shared store (e.g. Redis) when running multiple instances.
 */
export function createLimiter() {
  const buckets = new Map();
  let lastSweep = Date.now();

  function hit(key, limit, windowMs) {
    const t = Date.now();
    if (t - lastSweep > 60_000) {
      for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k);
      lastSweep = t;
    }
    let b = buckets.get(key);
    if (!b || b.reset < t) {
      b = { count: 0, reset: t + windowMs };
      buckets.set(key, b);
    }
    b.count++;
    return { allowed: b.count <= limit, retryAfter: Math.ceil((b.reset - t) / 1000), remaining: Math.max(0, limit - b.count) };
  }

  function check(key, limit, windowMs) {
    const r = hit(key, limit, windowMs);
    if (!r.allowed) {
      throw new HttpError(429, 'rate_limited', `Too many requests. Try again in ${r.retryAfter}s.`, { retryAfter: r.retryAfter });
    }
    return r;
  }

  /** Express middleware keyed by client IP (and user when signed in). */
  function middleware(name, limit, windowMs) {
    return (req, _res, next) => {
      try {
        const who = req.user ? `u:${req.user.id}` : `ip:${req.ip}`;
        check(`${name}:${who}`, limit, windowMs);
        next();
      } catch (err) {
        next(err);
      }
    };
  }

  const reset = () => buckets.clear();
  return { hit, check, middleware, reset };
}
