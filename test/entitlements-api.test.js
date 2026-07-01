// M2 entitlements over HTTP: claim flow (all five page states + API), rotate,
// usage, portal, cancellation read-only flow, and quota enforcement at the
// API surface. Stripe is mocked via options.stripeFetch (injectable, same
// pattern as createCheckoutSession tests).

import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createApp } from '../src/server.js';
import { MemoryStore } from '../src/memory-store.js';
import { loadBillingConfig } from '../src/billing.js';
import { hashKey, generateKey } from '../src/auth.js';
import { createRateLimiter } from '../src/rate-limit.js';

const PAID_SESSION = {
  id: 'cs_paid_1',
  payment_status: 'paid',
  customer: 'cus_alpha',
  subscription: 'sub_alpha',
  client_reference_id: 'starter',
  created: 1_000
};

// Mock Stripe API: GET checkout session + POST portal session.
function stripeFetch(url) {
  const path = String(url);
  if (path.includes('/checkout/sessions/cs_paid_1')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => PAID_SESSION });
  }
  if (path.includes('/checkout/sessions/cs_unpaid')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ ...PAID_SESSION, id: 'cs_unpaid', payment_status: 'unpaid' }) });
  }
  if (path.includes('/checkout/sessions/cs_down')) {
    return Promise.resolve({ ok: false, status: 503, json: async () => ({ error: { message: 'stripe is down' } }) });
  }
  if (path.includes('/checkout/sessions/')) {
    return Promise.resolve({ ok: false, status: 404, json: async () => ({ error: { message: 'no such session' } }) });
  }
  if (path.includes('/billing_portal/sessions')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ url: 'https://billing.stripe.test/p/session_1' }) });
  }
  throw new Error(`unexpected stripe call: ${path}`);
}

// Tiny plan limits so quota boundaries are reachable in tests.
const TEST_LIMITS = {
  demo: { maxDocuments: 2, packPullsPerMonth: 3, requestsPerMinute: 1000, maxStorageBytes: 10_000 },
  starter: { maxDocuments: 5, packPullsPerMonth: 5, requestsPerMinute: 1000, maxStorageBytes: 50_000 },
  team: { maxDocuments: 10, packPullsPerMonth: 10, requestsPerMinute: 1000, maxStorageBytes: 100_000 },
  enterprise: { maxDocuments: 10, packPullsPerMonth: 10, requestsPerMinute: 1000, maxStorageBytes: 100_000 }
};

let server;
let base;
let store;

before(async () => {
  store = new MemoryStore([]);
  server = createApp(store, {
    seedCount: 0,
    billing: loadBillingConfig({ STRIPE_SECRET_KEY: 'rk_test', STRIPE_WEBHOOK_SECRET: 'whsec_test' }),
    stripeFetch,
    planLimits: TEST_LIMITS,
    // The per-IP claim limiter is tested separately; the functional tests
    // here make many claim calls from one IP.
    claimLimiter: createRateLimiter({ windowMs: 60_000, max: 1_000 })
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const post = (path, body, headers = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

let claimedKey;

test('claim: paid session → key issued once; refresh → calm already-claimed page', async () => {
  const res = await post('/api/keys/claim', { sessionId: 'cs_paid_1' });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.match(body.key, /^bm_[0-9a-f]{48}$/);
  assert.equal(body.plan, 'starter');
  claimedKey = body.key;

  // Second claim of the same session → 409, never a second key.
  const again = await post('/api/keys/claim', { sessionId: 'cs_paid_1' });
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error, 'already_claimed');

  // The claim PAGE for the same session renders the calm refresh state.
  const page = await fetch(`${base}/claim?session_id=cs_paid_1`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /already issued/);
  assert.doesNotMatch(html, /bm_[0-9a-f]{48}/, 'no key ever re-renders');
});

test('claim page states: missing session, invalid session, stripe down', async () => {
  const missing = await fetch(`${base}/claim`);
  assert.equal(missing.status, 400);
  assert.match(await missing.text(), /needs a checkout session/);

  const invalid = await fetch(`${base}/claim?session_id=cs_nope`);
  assert.equal(invalid.status, 403);
  assert.match(await invalid.text(), /don't recognize/);

  const down = await fetch(`${base}/claim?session_id=cs_down`);
  assert.equal(down.status, 503);
  const downHtml = await down.text();
  assert.match(downHtml, /Your payment is safe/);
  assert.match(downHtml, /Retry now/);
});

test('claim API shadow paths: unpaid session 403, stripe 5xx → 503 with safe message', async () => {
  const unpaid = await post('/api/keys/claim', { sessionId: 'cs_unpaid' });
  assert.equal(unpaid.status, 403);

  const down = await post('/api/keys/claim', { sessionId: 'cs_down' });
  assert.equal(down.status, 503);
  assert.match((await down.json()).message, /payment is safe/i);

  const noSession = await post('/api/keys/claim', {});
  assert.equal(noSession.status, 400);
});

test('claimed key works for writes; /api/usage reports plan truthfully', async () => {
  const authed = { Authorization: `Bearer ${claimedKey}` };
  const created = await post('/api/documents', { id: 'first-doc', title: 'First', body: 'content' }, authed);
  assert.equal(created.status, 201);

  const usage = await fetch(`${base}/api/usage`, { headers: authed });
  assert.equal(usage.status, 200);
  const usageBody = await usage.json();
  assert.equal(usageBody.plan, 'starter');
  assert.equal(usageBody.documents.used, 1);
  assert.equal(usageBody.documents.limit, TEST_LIMITS.starter.maxDocuments);
});

test('pack-pull quota: 402 at the boundary, usage visible before the denial', async () => {
  const authed = { Authorization: `Bearer ${claimedKey}` };
  for (let i = 0; i < TEST_LIMITS.starter.packPullsPerMonth; i++) {
    const res = await fetch(`${base}/api/context-pack?q=content`, { headers: authed });
    assert.equal(res.status, 200, `pull ${i + 1} within quota`);
  }
  const denied = await fetch(`${base}/api/context-pack?q=content`, { headers: authed });
  assert.equal(denied.status, 402);
  assert.equal((await denied.json()).error, 'quota_exceeded');
});

test('document quota: 402 with plan numbers in the body', async () => {
  const demoKey = generateKey();
  await store.createKey({ id: 'ws-quota', plan: 'demo', keyHash: hashKey(demoKey) });
  const authed = { Authorization: `Bearer ${demoKey}` };

  await post('/api/documents', { title: 'one', body: 'x' }, authed);
  await post('/api/documents', { title: 'two', body: 'x' }, authed);
  const third = await post('/api/documents', { title: 'three', body: 'x' }, authed);
  assert.equal(third.status, 402);
  const body = await third.json();
  assert.equal(body.error, 'quota_exceeded');
  assert.equal(body.maxDocuments, TEST_LIMITS.demo.maxDocuments);
});

test('rotate: old key dies immediately, new key works, shown once', async () => {
  const res = await post('/api/keys/rotate', {}, { Authorization: `Bearer ${claimedKey}` });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.key, /^bm_[0-9a-f]{48}$/);

  const oldKey = await fetch(`${base}/api/usage`, { headers: { Authorization: `Bearer ${claimedKey}` } });
  assert.equal(oldKey.status, 401, 'old key invalid immediately');
  const newKey = await fetch(`${base}/api/usage`, { headers: { Authorization: `Bearer ${body.key}` } });
  assert.equal(newKey.status, 200);
  claimedKey = body.key;
});

test('billing portal: returns the hosted URL for stripe-linked keys; 400 for script-issued', async () => {
  const portal = await post('/api/billing/portal', {}, { Authorization: `Bearer ${claimedKey}` });
  assert.equal(portal.status, 200);
  assert.equal((await portal.json()).url, 'https://billing.stripe.test/p/session_1');

  const scriptKey = generateKey();
  await store.createKey({ id: 'ws-script', plan: 'demo', keyHash: hashKey(scriptKey) });
  const noCustomer = await post('/api/billing/portal', {}, { Authorization: `Bearer ${scriptKey}` });
  assert.equal(noCustomer.status, 400);
});

test('cancellation flow: read_only key reads and exports but cannot write', async () => {
  const key = await store.findKeyByHash(hashKey(claimedKey));
  await store.updateSubscriptionState('cus_alpha', {
    status: 'read_only',
    cancelledAt: '2026-06-11T00:00:00.000Z',
    eventCreated: 2_000
  });
  void key;

  const authed = { Authorization: `Bearer ${claimedKey}` };
  const read = await fetch(`${base}/api/search?q=content`, { headers: authed });
  assert.equal(read.status, 200, 'reads keep working through the grace window');

  const write = await post('/api/documents', { title: 'nope', body: 'x' }, authed);
  assert.equal(write.status, 403);
  const writeBody = await write.json();
  assert.equal(writeBody.error, 'read_only_key');
  assert.ok(writeBody.graceEndsAt !== undefined, 'body carries the grace context');
});

test('anonymous reads are rate-limited per IP (each anon hit is a paid query)', async () => {
  const tightServer = createApp(new MemoryStore([]), {
    seedCount: 0,
    billing: loadBillingConfig({}),
    planLimits: TEST_LIMITS,
    anonReadLimiter: (await import('../src/rate-limit.js')).createRateLimiter({ windowMs: 60_000, max: 2 })
  });
  await new Promise((resolve) => tightServer.listen(0, '127.0.0.1', resolve));
  const tightBase = `http://127.0.0.1:${tightServer.address().port}`;
  try {
    await fetch(`${tightBase}/api/search?q=x`);
    await fetch(`${tightBase}/api/search?q=x`);
    const limited = await fetch(`${tightBase}/api/search?q=x`);
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get('retry-after'));
  } finally {
    await new Promise((resolve) => tightServer.close(resolve));
  }
});
