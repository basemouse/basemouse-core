import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContextPack, filterItems, resolveLimit, searchRepository, validateFacet, validateQuery } from './basemouse-core.js';
import { hybridSearchWithVectors, validateRetrieval, vectorRetrievalInfo } from './retrieval.js';
import { loadDocuments } from './store.js';
import { MemoryStore } from './memory-store.js';
import { PgStore } from './pg-store.js';
import { resolveKey, visibleWorkspaces } from './auth.js';
import { StoreUnavailableError, toResponse } from './errors.js';
import {
  MAX_DOC_BODY_BYTES,
  createDocumentHandler,
  deleteDocumentHandler,
  historyHandler,
  updateDocumentHandler
} from './handlers/documents.js';
import { claimKeyHandler, portalHandler, rotateKeyHandler, usageHandler } from './handlers/keys.js';
import { stripeWebhookHandler } from './handlers/stripe-webhook.js';
import { handleMcpRequest } from './handlers/mcp.js';
import { createMetrics, runAlertChecks } from './metrics.js';
import {
  renderAlreadyClaimed,
  renderInvalidSession,
  renderKeyShown,
  renderMissingSession,
  renderStripeDown
} from './handlers/claim-page.js';
import { AlreadyClaimedError, InvalidSessionError, QuotaExceededError, StorageQuotaExceededError, StripeUnavailableError } from './errors.js';
import { currentMonth, limitsForPlan, loadPlanLimits } from './quota.js';
import { createCheckoutSession as defaultCreateCheckoutSession, findTier, loadBillingConfig, publicBillingConfig } from './billing.js';
import { createRateLimiter, clientIp } from './rate-limit.js';
import { createTelemetry, loadTelemetryConfig } from './telemetry.js';
import { loadLicenseConfig, publicLicenseStatus } from './license.js';

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_DIR = resolve(join(ROOT, 'public'));
const MAX_BODY_BYTES = 4 * 1024; // checkout bodies are tiny ({ "tier": "team" })

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8'
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  // Scripts stay self-only. Styles allow inline + Google Fonts CSS (the claim
  // page styles inline by design; fonts load from fonts.gstatic.com).
  'Content-Security-Policy': "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'"
};

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...SECURITY_HEADERS,
    ...extraHeaders
  });
  res.end(body);
}

// Resolve a request path strictly inside PUBLIC_DIR.
// Returns { ok:true, filePath }, { ok:false, status:403 } for traversal,
// or { ok:false, status:400 } for malformed percent-encoding.
function resolveStaticPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { ok: false, status: 400, payload: { error: 'bad_request' } };
  }

  const rel = normalize(decoded === '/' ? '/index.html' : decoded).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = resolve(join(PUBLIC_DIR, rel));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + sep)) {
    return { ok: false, status: 403, payload: { error: 'forbidden' } };
  }
  return { ok: true, filePath };
}

async function sendStatic(res, pathname) {
  const resolved = resolveStaticPath(pathname);
  if (!resolved.ok) {
    return sendJson(res, resolved.status, resolved.payload);
  }
  const { filePath } = resolved;
  const info = await stat(filePath).catch(() => null);
  if (!info || !info.isFile()) {
    return sendJson(res, 404, { error: 'not_found' });
  }
  const data = await readFile(filePath);
  res.writeHead(200, {
    'Content-Type': contentTypes[extname(filePath)] || 'application/octet-stream',
    ...SECURITY_HEADERS
  });
  res.end(data);
}

// Read and JSON-parse a request body with a hard size cap. Returns
// { ok:true, value } or { ok:false, status, payload } so the caller can respond
// with the right error without throwing.
function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        finish({ ok: false, status: 413, payload: { error: 'payload_too_large', message: `body exceeds ${limit} bytes` } });
        // Drain instead of destroying the socket: destroying races the 413
        // response and the client sees a connection reset instead of an error
        // it can act on. The drain is bounded by the request size itself.
        chunks.length = 0;
        req.removeAllListeners('data');
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') return finish({ ok: true, value: {} });
      try {
        finish({ ok: true, value: JSON.parse(raw) });
      } catch {
        finish({ ok: false, status: 400, payload: { error: 'invalid_json', message: 'request body must be valid JSON' } });
      }
    });
    req.on('error', () => finish({ ok: false, status: 400, payload: { error: 'bad_request' } }));
  });
}

// Read the EXACT raw request body (no JSON parse) — Stripe signature
// verification hashes the raw bytes, so any re-serialization breaks it.
function readRawBody(req, limit = 1024 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        finish({ ok: false, status: 413, payload: { error: 'payload_too_large' } });
        chunks.length = 0;
        req.removeAllListeners('data');
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ ok: true, raw: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => finish({ ok: false, status: 400, payload: { error: 'bad_request' } }));
  });
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
  res.end(html);
}

// POST /api/checkout — start a Stripe Checkout Session for a purchasable tier.
// Validates content type, body size/shape, and the requested tier, and degrades
// gracefully to 503 when billing is not configured.
async function handleCheckout(req, res, billing, createCheckoutSession) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('application/json')) {
    return sendJson(res, 415, { error: 'unsupported_media_type', message: 'expected application/json' });
  }

  const body = await readJsonBody(req);
  if (!body.ok) {
    return sendJson(res, body.status, body.payload);
  }

  const tierId = typeof body.value?.tier === 'string' ? body.value.tier.trim() : '';
  if (!tierId) {
    return sendJson(res, 400, { error: 'invalid_request', message: 'tier is required' });
  }

  if (!billing.enabled) {
    return sendJson(res, 503, {
      error: 'billing_disabled',
      message: 'Billing is not configured. Please contact sales.',
      contactSalesUrl: billing.contactSalesUrl
    });
  }

  const tier = findTier(billing, tierId);
  if (!tier) {
    return sendJson(res, 404, { error: 'unknown_tier', message: `no such tier: ${tierId}` });
  }
  if (!tier.checkout) {
    return sendJson(res, 409, {
      error: 'tier_not_purchasable',
      message: `${tier.name} is contact-sales only.`,
      contactSalesUrl: billing.contactSalesUrl
    });
  }

  try {
    const session = await createCheckoutSession(billing, tier.id);
    return sendJson(res, 200, { url: session.url, tier: tier.id });
  } catch (error) {
    console.error('checkout_failed', error);
    return sendJson(res, 502, { error: 'checkout_failed', message: 'Could not start checkout. Please try again later.' });
  }
}

// `repositoryOrStore` accepts either a plain document array (legacy tests,
// dev) — wrapped in a MemoryStore — or a store implementing the M1 contract
// (MemoryStore/PgStore). `options.fallbackStore` is the seed-corpus
// MemoryStore used to keep the public demo alive when Postgres is down
// (design decision 1A): anonymous reads degrade to it with an
// X-BaseMouse-Degraded header; authenticated reads get the registry's 503.
export function createApp(repositoryOrStore, options = {}) {
  const store = Array.isArray(repositoryOrStore)
    ? new MemoryStore(repositoryOrStore)
    : repositoryOrStore;
  const fallbackStore = options.fallbackStore || null;
  const seedCount = Array.isArray(repositoryOrStore)
    ? repositoryOrStore.length
    : options.seedCount ?? 0;
  const degradedState = { active: false };

  const billing = options.billing || loadBillingConfig();
  const createCheckoutSession = options.createCheckoutSession || defaultCreateCheckoutSession;
  // /api/checkout is the one unauthenticated write endpoint and each call creates
  // a Stripe Checkout Session (a billable, server-side API call). Throttle per
  // client IP so it can't be driven in a loop. Conservative default (20/min),
  // overridable via env, injectable for tests.
  const checkoutLimiter = options.checkoutLimiter || createRateLimiter({
    windowMs: Number(process.env.CHECKOUT_RATE_WINDOW_MS) || 60_000,
    max: Number(process.env.CHECKOUT_RATE_MAX) || 20
  });
  // Claim mints credentials and calls Stripe per attempt — tightest limit
  // of all (OV-E1.5). Anonymous reads are now paid PG queries, so they get
  // the per-IP limiter too (OV-E1.4); authenticated reads are governed by
  // per-key plan rates instead.
  const claimLimiter = options.claimLimiter || createRateLimiter({
    windowMs: 60_000,
    max: Number(process.env.CLAIM_RATE_MAX) || 5
  });
  const anonReadLimiter = options.anonReadLimiter || createRateLimiter({
    windowMs: 60_000,
    max: Number(process.env.ANON_READ_RATE_MAX) || 60
  });
  const keyReadLimiters = new Map(); // plan -> limiter (per-replica, DoS smoothing only)
  const planLimits = options.planLimits || loadPlanLimits();

  function checkReadRate(req, auth) {
    if (!auth) {
      const limit = anonReadLimiter.check(clientIp(req));
      return limit.allowed ? null : limit;
    }
    const plan = auth.plan || 'demo';
    if (!keyReadLimiters.has(plan)) {
      keyReadLimiters.set(plan, createRateLimiter({
        windowMs: 60_000,
        max: limitsForPlan(planLimits, plan).requestsPerMinute
      }));
    }
    const limit = keyReadLimiters.get(plan).check(auth.keyId);
    return limit.allowed ? null : limit;
  }
  // MeshAI integration: emit an OTLP evidence span for each context pack so MeshAI
  // (or any OTel backend) can observe and audit what context agents pull. Disabled
  // and no-op until MESHAI_OTLP_ENDPOINT + MESHAI_API_KEY are configured.
  const telemetry = options.telemetry || createTelemetry(loadTelemetryConfig());

  // License/self-hosted posture — informational only (never an enforcement gate;
  // local/dev runs as "open"). publicLicenseStatus() is non-secret and safe to
  // surface on the unauthenticated /healthz; the raw key never leaves the server.
  const license = options.license || loadLicenseConfig();

  // Load the visible corpus for a read request. Anonymous reads survive a
  // Postgres outage by degrading to the seed fallback; authenticated reads
  // surface the registry's 503 (StoreUnavailableError) untouched.
  const metrics = options.metrics || createMetrics();

  async function loadVisible(auth) {
    try {
      const docs = await store.listVisible(visibleWorkspaces(auth));
      degradedState.active = false;
      metrics.setDegraded(false);
      metrics.inc('search_path_scan');
      return { docs, degraded: false };
    } catch (error) {
      if (error instanceof StoreUnavailableError && !auth && fallbackStore) {
        degradedState.active = true;
        metrics.setDegraded(true);
        return { docs: await fallbackStore.listVisible(visibleWorkspaces(null)), degraded: true };
      }
      throw error;
    }
  }

  // Authenticated MCP/REST pack pulls share one metering closure: the plan's
  // monthly quota in Postgres, exactly (never the in-memory counters).
  const meterFor = (auth) => () =>
    store.recordPackPull(auth.keyId, currentMonth(), limitsForPlan(planLimits, auth.plan).packPullsPerMonth);

  const degradedHeaders = (degraded) => (degraded ? { 'X-BaseMouse-Degraded': 'true' } : {});

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const method = req.method || 'GET';
    try {

      // Checkout is the one write endpoint; everything else is read-only.
      if (url.pathname === '/api/checkout') {
        if (method !== 'POST') {
          return sendJson(res, 405, { error: 'method_not_allowed', allow: 'POST' });
        }
        const limit = checkoutLimiter.check(clientIp(req));
        if (!limit.allowed) {
          return sendJson(res, 429, { error: 'rate_limited', message: 'Too many checkout attempts. Please wait and try again.' }, { 'Retry-After': String(limit.retryAfterSec) });
        }
        return await handleCheckout(req, res, billing, createCheckoutSession);
      }

      // Inbound Stripe webhook: raw body, SDK-verified signature.
      if (url.pathname === '/api/stripe/webhook') {
        if (method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed', allow: 'POST' });
        const body = await readRawBody(req);
        if (!body.ok) return sendJson(res, body.status, body.payload);
        const result = await stripeWebhookHandler(store, billing, body.raw, req.headers['stripe-signature']);
        return sendJson(res, result.status, result.body);
      }

      // MCP: the second door to the same product — JSON-RPC over Streamable
      // HTTP, stateless, same auth/scoping/metering as REST.
      if (url.pathname === '/mcp') {
        if (method !== 'POST') {
          return sendJson(res, 405, { error: 'method_not_allowed', allow: 'POST', message: 'stateless MCP: POST JSON-RPC messages; no SSE stream' });
        }
        const auth = await resolveKey(req, store);
        const rate = checkReadRate(req, auth);
        if (rate) return sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(rate.retryAfterSec) });
        const body = await readJsonBody(req);
        if (!body.ok) return sendJson(res, body.status, body.payload);
        const { docs } = await loadVisible(auth);
        const reply = await handleMcpRequest(body.value, {
          docs,
          auth,
          meterPackPull: auth ? meterFor(auth) : null
        });
        if (reply === null) {
          res.writeHead(202, SECURITY_HEADERS);
          return res.end();
        }
        if (body.value?.method === 'tools/call' && body.value?.params?.name === 'get_context_pack' && !reply.result?.isError) {
          metrics.inc('pack_pulls');
        }
        return sendJson(res, 200, reply);
      }

      // Claim: unauthenticated, mints credentials, calls Stripe — tightly limited.
      if (url.pathname === '/api/keys/claim') {
        if (method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed', allow: 'POST' });
        const limit = claimLimiter.check(clientIp(req));
        if (!limit.allowed) {
          return sendJson(res, 429, { error: 'rate_limited', message: 'Too many claim attempts. Please wait.' }, { 'Retry-After': String(limit.retryAfterSec) });
        }
        const body = await readJsonBody(req);
        if (!body.ok) return sendJson(res, body.status, body.payload);
        try {
          const result = await claimKeyHandler(store, billing, body.value, options.stripeFetch ? { fetchImpl: options.stripeFetch } : {});
          metrics.inc('claims_ok');
          return sendJson(res, result.status, result.body);
        } catch (error) {
          // Refreshes (already_claimed) are benign — only real failures count
          // toward the claim-failure alert.
          if (!(error instanceof AlreadyClaimedError)) metrics.recordClaimFailure();
          throw error;
        }
      }

      if (url.pathname === '/api/keys/rotate') {
        if (method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed', allow: 'POST' });
        const auth = await resolveKey(req, store);
        const result = await rotateKeyHandler(store, auth);
        return sendJson(res, result.status, result.body);
      }

      if (url.pathname === '/api/billing/portal') {
        if (method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed', allow: 'POST' });
        const auth = await resolveKey(req, store);
        const result = await portalHandler(store, billing, auth, options.stripeFetch ? { fetchImpl: options.stripeFetch } : {});
        return sendJson(res, result.status, result.body);
      }

      // Document writes: POST /api/documents, PUT/DELETE /api/documents/:id.
      const docMatch = /^\/api\/documents(?:\/([a-z0-9][a-z0-9-]*))?(\/history)?$/.exec(url.pathname);
      if (docMatch) {
        const [, docId, isHistory] = docMatch;
        const auth = await resolveKey(req, store);

        if (isHistory && docId && (method === 'GET' || method === 'HEAD')) {
          const result = await historyHandler(store, auth, docId);
          return sendJson(res, result.status, result.body);
        }
        if (method === 'POST' && !docId) {
          const body = await readJsonBody(req, MAX_DOC_BODY_BYTES);
          if (!body.ok) return sendJson(res, body.status, body.payload);
          const limits = auth ? limitsForPlan(planLimits, auth.plan) : null;
          const result = await createDocumentHandler(store, auth, body.value, limits);
          return sendJson(res, result.status, result.body);
        }
        if (method === 'PUT' && docId && !isHistory) {
          const body = await readJsonBody(req, MAX_DOC_BODY_BYTES);
          if (!body.ok) return sendJson(res, body.status, body.payload);
          const result = await updateDocumentHandler(store, auth, docId, body.value, req.headers['if-match']);
          return sendJson(res, result.status, result.body);
        }
        if (method === 'DELETE' && docId && !isHistory) {
          const result = await deleteDocumentHandler(store, auth, docId);
          return sendJson(res, result.status, result.body);
        }
        return sendJson(res, 405, { error: 'method_not_allowed', allow: 'GET, POST, PUT, DELETE' });
      }

      if (method !== 'GET' && method !== 'HEAD') {
        return sendJson(res, 405, { error: 'method_not_allowed', allow: 'GET, HEAD' });
      }

      // Operational counters — Prometheus text format, human-readable by curl.
      if (url.pathname === '/metrics') {
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', ...SECURITY_HEADERS });
        return res.end(metrics.render());
      }

      if (url.pathname === '/api/openapi.json') {
        return await sendStatic(res, '/openapi.json');
      }

      // Liveness: process-only — a database blip must never restart-loop pods.
      if (url.pathname === '/healthz') {
        return sendJson(res, 200, {
          ok: true,
          service: 'basemouse',
          version: '0.2.0',
          documents: seedCount,
          billing: billing.enabled,
          meshai: telemetry.enabled,
          // Non-secret deployment posture. Never includes the license key.
          license: publicLicenseStatus(license)
        });
      }

      // Readiness: pings the store, and reports ready (200) in degraded
      // demo-fallback mode — if readiness failed when PG is down, k8s would
      // pull every pod from the Service and the fallback could never serve.
      if (url.pathname === '/readyz') {
        try {
          await store.ping();
          degradedState.active = false;
          return sendJson(res, 200, { ready: true, degraded: false, store: store.constructor.name, documents: seedCount });
        } catch {
          if (fallbackStore) {
            degradedState.active = true;
            return sendJson(res, 200, { ready: true, degraded: true, store: 'MemoryStore(fallback)', documents: seedCount });
          }
          return sendJson(res, 503, { ready: false });
        }
      }

      if (url.pathname === '/api/billing/config') {
        return sendJson(res, 200, publicBillingConfig(billing));
      }

      if (url.pathname === '/api/usage') {
        const auth = await resolveKey(req, store);
        const result = await usageHandler(store, auth, planLimits);
        return sendJson(res, result.status, result.body);
      }

      if (url.pathname === '/api/repository') {
        const auth = await resolveKey(req, store);
        const rate = checkReadRate(req, auth);
        if (rate) return sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(rate.retryAfterSec) });
        const pageLimit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 500);
        const offset = Math.max(Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);
        const { docs, degraded } = await loadVisible(auth);
        return sendJson(res, 200, {
          count: docs.length,
          limit: pageLimit,
          offset,
          items: docs.slice(offset, offset + pageLimit)
        }, degradedHeaders(degraded));
      }

      if (url.pathname === '/api/search') {
        const q = validateQuery(url.searchParams.get('q'), { required: true });
        if (!q.ok) return sendJson(res, 400, { error: 'invalid_query', message: q.error });
        const typeFacet = validateFacet(url.searchParams.get('type'), 'type');
        if (!typeFacet.ok) return sendJson(res, 400, { error: 'invalid_filter', message: typeFacet.error });
        const tagFacet = validateFacet(url.searchParams.get('tag'), 'tag');
        if (!tagFacet.ok) return sendJson(res, 400, { error: 'invalid_filter', message: tagFacet.error });
        const retrieval = validateRetrieval(url.searchParams.get('retrieval'));
        if (!retrieval.ok) return sendJson(res, 400, { error: 'invalid_retrieval', message: retrieval.error });

        const auth = await resolveKey(req, store);
        const rate = checkReadRate(req, auth);
        if (rate) return sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(rate.retryAfterSec) });
        const { docs, degraded } = await loadVisible(auth);
        const matched = retrieval.value === 'hybrid'
          ? hybridSearchWithVectors(docs, q.value)
          : searchRepository(docs, q.value);
        const results = filterItems(matched, { type: typeFacet.value, tag: tagFacet.value });
        return sendJson(res, 200, {
          query: q.value,
          retrieval: retrieval.value,
          // Local hashed-vector backend metadata, distinct from graph/lexical.
          // Only present for hybrid mode and only when vector retrieval is on.
          vector: retrieval.value === 'hybrid' ? vectorRetrievalInfo() : null,
          filters: { type: typeFacet.value || null, tag: tagFacet.value || null },
          count: results.length,
          results
        }, degradedHeaders(degraded));
      }

      if (url.pathname === '/api/context-pack') {
        const q = validateQuery(url.searchParams.get('q'));
        if (!q.ok) return sendJson(res, 400, { error: 'invalid_query', message: q.error });
        const limit = resolveLimit(url.searchParams.get('limit'));
        if (!limit.ok) return sendJson(res, 400, { error: 'invalid_limit', message: limit.error });
        const typeFacet = validateFacet(url.searchParams.get('type'), 'type');
        if (!typeFacet.ok) return sendJson(res, 400, { error: 'invalid_filter', message: typeFacet.error });
        const tagFacet = validateFacet(url.searchParams.get('tag'), 'tag');
        if (!tagFacet.ok) return sendJson(res, 400, { error: 'invalid_filter', message: tagFacet.error });
        const retrieval = validateRetrieval(url.searchParams.get('retrieval'));
        if (!retrieval.ok) return sendJson(res, 400, { error: 'invalid_retrieval', message: retrieval.error });

        const auth = await resolveKey(req, store);
        const rate = checkReadRate(req, auth);
        if (rate) return sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(rate.retryAfterSec) });
        // Pack pulls are the metered unit: authenticated pulls count against
        // the plan's monthly quota (exact, in Postgres); anonymous demo pulls
        // are rate-limited per IP instead.
        if (auth) {
          await meterFor(auth)();
        }
        metrics.inc('pack_pulls');
        const { docs, degraded } = await loadVisible(auth);
        const startMs = Date.now();
        const pack = createContextPack(docs, {
          query: q.value || undefined,
          limit: limit.value,
          filters: { type: typeFacet.value, tag: tagFacet.value },
          retrieval: retrieval.value,
          search: retrieval.value === 'hybrid' ? hybridSearchWithVectors : undefined
        });
        if (degraded) pack.corpus = 'demo-fallback';
        // Surface the local vector backend in the pack's retrieval summary so
        // callers can tell vector signals from graph/lexical ones. Gate on the
        // mode the pack actually ran (hybrid requires a query) so the vector
        // block stays consistent with `weights` and never claims the vector
        // backend ran on a query-less, lexical-fallback pack.
        if (pack.retrieval?.mode === 'hybrid') {
          pack.retrieval.vector = vectorRetrievalInfo();
        }
        // Fire-and-forget MeshAI evidence emission. Never await it and never let a
        // misbehaving emitter throw into the context-pull path — telemetry is
        // strictly best-effort and the pack is returned regardless.
        try {
          void telemetry.emitContextPack(pack, { startMs });
        } catch {
          /* telemetry must never break a context pull */
        }
        // Delight rider: the whole pack's checksum in a header, so callers can
        // verify what they received without parsing it first.
        const packChecksum = createHash('sha256').update(JSON.stringify(pack)).digest('hex').slice(0, 16);
        return sendJson(res, 200, pack, { ...degradedHeaders(degraded), 'X-BaseMouse-Pack-Checksum': packChecksum });
      }

      if (url.pathname.startsWith('/api/')) {
        return sendJson(res, 404, { error: 'not_found' });
      }

      // The claim page: the post-checkout five-state flow (11A). The claim
      // executes server-side on this GET so the page works without JS;
      // a refresh after success renders the calm already-claimed state.
      if (url.pathname === '/claim') {
        const sessionId = url.searchParams.get('session_id');
        if (!sessionId) return sendHtml(res, 400, renderMissingSession());
        const limit = claimLimiter.check(clientIp(req));
        if (!limit.allowed) return sendHtml(res, 429, renderStripeDown(sessionId));
        try {
          const result = await claimKeyHandler(store, billing, { sessionId }, options.stripeFetch ? { fetchImpl: options.stripeFetch } : {});
          metrics.inc('claims_ok');
          return sendHtml(res, 200, renderKeyShown(result.body));
        } catch (error) {
          if (error instanceof AlreadyClaimedError) return sendHtml(res, 200, renderAlreadyClaimed());
          metrics.recordClaimFailure();
          if (error instanceof StripeUnavailableError) return sendHtml(res, 503, renderStripeDown(sessionId));
          if (error instanceof InvalidSessionError) return sendHtml(res, 403, renderInvalidSession());
          throw error;
        }
      }

      return await sendStatic(res, url.pathname);
    } catch (error) {
      // Named errors carry their own contract (status, code, headers);
      // anything else is logged with request context and becomes a 500.
      if (error instanceof QuotaExceededError || error instanceof StorageQuotaExceededError) {
        metrics.inc('quota_denials');
      }
      const mapped = toResponse(error, `${method} ${url.pathname}`);
      return sendJson(res, mapped.status, mapped.payload, mapped.headers);
    }
  });
  // Exposed for the boot block (alert checker) and tests.
  server.basemouseMetrics = metrics;
  return server;
}

// Only auto-start when run directly, so tests can import createApp.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const seeds = await loadDocuments();
  const fallbackStore = new MemoryStore(seeds);
  let store = fallbackStore;

  if (process.env.DATABASE_URL) {
    store = new PgStore(process.env.DATABASE_URL);
    // Idempotent seed import with backoff — the pod stays alive (and serves
    // the demo from memory) while Postgres is unreachable at boot.
    const importSeeds = async (attempt = 1) => {
      try {
        await store.ensureSeeds(seeds);
        console.log('seed corpus ensured in Postgres');
      } catch (error) {
        const delay = Math.min(2 ** attempt * 1000, 60_000);
        console.warn(`seed import failed (attempt ${attempt}): ${error.message}; retrying in ${delay}ms`);
        setTimeout(() => importSeeds(attempt + 1), delay).unref();
      }
    };
    await importSeeds();
  }

  const server = createApp(store, { fallbackStore, seedCount: seeds.length });
  // In-app alerting (design decision 8A): the system pages the operator.
  if (process.env.ALERT_WEBHOOK_URL) {
    setInterval(() => {
      runAlertChecks(server.basemouseMetrics).catch(() => {});
    }, 60_000).unref();
    console.log('alerting armed (ALERT_WEBHOOK_URL configured)');
  }
  server.listen(PORT, HOST, () => {
    const mode = process.env.DATABASE_URL ? 'postgres' : 'memory';
    console.log(`BaseMouse listening on http://${HOST}:${PORT} (${seeds.length} seed documents, ${mode} store)`);
  });
}
