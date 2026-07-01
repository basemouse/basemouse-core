// In-memory fixed-window rate limiter (ESM). Zero dependencies, per-process
// state. BaseMouse runs a single replica behind the cluster ingress, so
// process-local counters are sufficient. A horizontal scale-out would need a
// shared store (e.g. Redis) — called out here so the limitation is visible
// rather than a silent correctness bug if replicas > 1.

export function createRateLimiter({ windowMs = 60_000, max = 30, now = Date.now } = {}) {
  const hits = new Map(); // key -> { count, resetAt }

  function check(key) {
    const t = now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= t) {
      entry = { count: 0, resetAt: t + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    // Opportunistic sweep so an attacker rotating keys can't grow the map without
    // bound. Cheap: only runs once the map is already large.
    if (hits.size > 10_000) {
      for (const [k, v] of hits) {
        if (v.resetAt <= t) hits.delete(k);
      }
    }
    const allowed = entry.count <= max;
    const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - t) / 1000));
    return { allowed, remaining: Math.max(0, max - entry.count), retryAfterSec };
  }

  return { check };
}

// Best-effort client IP for rate-limit bucketing. Behind the ingress the real
// client is the first hop in X-Forwarded-For; fall back to the socket address
// for direct hits. XFF is only trusted for bucketing — a spoofed value merely
// moves the spoofer into a different bucket, it never grants more quota.
export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
