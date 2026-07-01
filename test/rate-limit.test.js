import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/server.js';
import { loadBillingConfig } from '../src/billing.js';
import { createSeedRepository } from '../src/store.js';
import { createRateLimiter, clientIp } from '../src/rate-limit.js';

test('createRateLimiter allows up to max within a window, then blocks', () => {
  let clock = 1000;
  const limiter = createRateLimiter({ windowMs: 60_000, max: 2, now: () => clock });
  assert.equal(limiter.check('a').allowed, true);
  assert.equal(limiter.check('a').allowed, true);
  const blocked = limiter.check('a');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec >= 1 && blocked.retryAfterSec <= 60);
});

test('createRateLimiter resets after the window and buckets keys independently', () => {
  let clock = 0;
  const limiter = createRateLimiter({ windowMs: 1000, max: 1, now: () => clock });
  assert.equal(limiter.check('a').allowed, true);
  assert.equal(limiter.check('a').allowed, false);
  assert.equal(limiter.check('b').allowed, true);
  clock = 1001;
  assert.equal(limiter.check('a').allowed, true);
});

test('clientIp prefers the first X-Forwarded-For hop, falls back to the socket', () => {
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }, socket: { remoteAddress: '10.0.0.2' } }), '203.0.113.7');
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: '198.51.100.4' } }), '198.51.100.4');
  assert.equal(clientIp({ headers: {}, socket: {} }), 'unknown');
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

test('POST /api/checkout returns 429 with Retry-After once the per-IP limit is exceeded', async () => {
  const billing = loadBillingConfig({
    CHECKOUT_ENABLED: 'true',
    STRIPE_SECRET_KEY: 'sk_test_dummy',
    STRIPE_PRICE_TEAM: 'price_team_dummy'
  });
  const server = createApp(createSeedRepository(), {
    billing,
    createCheckoutSession: async (_billing, tier) => ({ url: `https://checkout.stripe.com/${tier}`, id: 'cs_test_1' }),
    checkoutLimiter: createRateLimiter({ windowMs: 60_000, max: 1 })
  });
  const base = await listen(server);
  try {
    const ok = await fetch(`${base}/api/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tier: 'team' })
    });
    assert.equal(ok.status, 200);

    const limited = await fetch(`${base}/api/checkout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tier: 'team' })
    });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    const body = await limited.json();
    assert.equal(body.error, 'rate_limited');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
