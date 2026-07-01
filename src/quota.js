// Plan limits and quota arithmetic (design doc: plan limits matrix).
// Defaults ship in code; operators may override via PLAN_LIMITS_JSON — but
// test/billing.test.js asserts TIERS marketing copy against the EFFECTIVE
// limits, so an override can never silently drift from the advertised copy.
//
// Quota enforcement model:
//   - maxDocuments / maxStorageBytes: lifetime counters on the keys row,
//     moved in the same transaction as the write (never a racy COUNT(*)).
//   - packPullsPerMonth: one usage row per key per calendar UTC month,
//     incremented atomically with UPDATE ... RETURNING.
//   - requestsPerMinute: per-replica in-memory limiter — DoS smoothing only,
//     explicitly approximate under replicas; never entitlement enforcement.

export const DEFAULT_PLAN_LIMITS = {
  demo: { maxDocuments: 500, packPullsPerMonth: 5_000, requestsPerMinute: 60, maxStorageBytes: 100 * 1024 * 1024 },
  starter: { maxDocuments: 2_000, packPullsPerMonth: 20_000, requestsPerMinute: 300, maxStorageBytes: 1024 * 1024 * 1024 },
  team: { maxDocuments: 20_000, packPullsPerMonth: 200_000, requestsPerMinute: 1_000, maxStorageBytes: 10 * 1024 * 1024 * 1024 },
  enterprise: { maxDocuments: 1_000_000, packPullsPerMonth: 10_000_000, requestsPerMinute: 10_000, maxStorageBytes: 100 * 1024 * 1024 * 1024 }
};

export function loadPlanLimits(env = process.env) {
  if (!env.PLAN_LIMITS_JSON) return DEFAULT_PLAN_LIMITS;
  try {
    const overrides = JSON.parse(env.PLAN_LIMITS_JSON);
    const merged = {};
    for (const [plan, defaults] of Object.entries(DEFAULT_PLAN_LIMITS)) {
      merged[plan] = { ...defaults, ...(overrides[plan] || {}) };
    }
    return merged;
  } catch {
    console.error('PLAN_LIMITS_JSON is not valid JSON — falling back to code defaults');
    return DEFAULT_PLAN_LIMITS;
  }
}

export function limitsForPlan(planLimits, plan) {
  return planLimits[plan] || planLimits.demo;
}

// Calendar UTC month key, e.g. '2026-06' (quota resets are month boundaries,
// not billing anniversaries — design decision OV1.5/quota).
export function currentMonth(now = new Date()) {
  return now.toISOString().slice(0, 7);
}
