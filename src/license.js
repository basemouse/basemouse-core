// License / self-hosted mode reporting for BaseMouse.
//
// Zero dependencies. This module reads the deployment's license posture from
// environment variables and produces a SAFE, non-secret status object that can
// be surfaced on an unauthenticated endpoint (e.g. /healthz). It mirrors the
// pattern of billing.js and telemetry.js: a pure `loadLicenseConfig(env)` and a
// browser-safe `publicLicenseStatus(config)` projection.
//
// Design constraints (intentional):
//   - NEVER block local/dev use. An absent license key is a valid, fully
//     functional "open" deployment — licensing here is informational, not an
//     enforcement gate. (Enforcement is a roadmap item; see docs/enterprise-self-hosted.md.)
//   - NEVER leak the license key. The raw key value is held server-side only and
//     is never included in the public status. We expose presence (`licensed`),
//     not the secret.
//   - Tiers are advisory labels — open | starter | team | enterprise — aligned
//     with the published plan names. Unknown values normalize to `open`.
//
//   env ──> loadLicenseConfig ──> { tier, selfHosted, licenseKey (server-only), ... }
//                                          │
//                                          └─> publicLicenseStatus ──> /healthz.license

const TIERS = ['open', 'starter', 'team', 'enterprise'];
const DEFAULT_TIER = 'open';

function stringOrNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Normalize an arbitrary tier label to one of the known tiers. Unknown or
// missing values fall back to `open` so a misconfigured env never escalates
// privileges or breaks reporting.
export function normalizeTier(value) {
  const raw = stringOrNull(value);
  if (!raw) return DEFAULT_TIER;
  const lowered = raw.toLowerCase();
  return TIERS.includes(lowered) ? lowered : DEFAULT_TIER;
}

// Interpret optional expiry text. The env may carry a human/ISO date string in
// BASEMOUSE_LICENSE_EXPIRES_AT; we keep it verbatim AND, when it parses as a
// date, compute whether it is in the past. `now` is injectable for tests.
// Returns { text, expired } where expired is null when there is no expiry or it
// cannot be parsed (we never guess — unparseable expiry is reported, not enforced).
function interpretExpiry(value, now) {
  const text = stringOrNull(value);
  if (!text) return { text: null, expired: null };
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) return { text, expired: null };
  return { text, expired: parsed < now };
}

// Build the server-side license configuration from environment variables. Pure
// with respect to its `env` argument so tests can pass a fixture object. The
// license key is server-only and must never be serialized to a response.
export function loadLicenseConfig(env = process.env, { now = Date.now() } = {}) {
  const licenseKey = stringOrNull(env.BASEMOUSE_LICENSE_KEY); // server-only secret
  const tier = normalizeTier(env.BASEMOUSE_LICENSE_TIER);
  const selfHosted = stringOrNull(env.BASEMOUSE_SELF_HOSTED) === 'true';
  const expiry = interpretExpiry(env.BASEMOUSE_LICENSE_EXPIRES_AT, now);

  return {
    licenseKey, // never include in publicLicenseStatus or any HTTP response
    tier,
    selfHosted,
    licensed: Boolean(licenseKey),
    expiresAt: expiry.text,
    expired: expiry.expired
  };
}

// Browser/operator-safe projection of the license config. NEVER includes the
// license key. Safe to return from an unauthenticated endpoint: it carries only
// the deployment posture (mode, tier, whether a key is present, expiry text).
export function publicLicenseStatus(config) {
  return {
    // Human-friendly mode label for dashboards/health checks.
    mode: config.selfHosted ? 'self-hosted' : 'hosted',
    selfHosted: config.selfHosted,
    tier: config.tier,
    // Whether a license key was supplied — presence only, never the value.
    licensed: config.licensed,
    source: config.licensed ? 'env' : 'none',
    expiresAt: config.expiresAt,
    expired: config.expired
  };
}

export { TIERS };
