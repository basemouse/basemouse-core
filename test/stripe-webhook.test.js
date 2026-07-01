// Inbound Stripe webhook tests: real signature verification (the SDK's own
// test-header generator signs payloads with the same scheme Stripe uses),
// idempotency, the three handled event types, and out-of-order resolution.

import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import Stripe from 'stripe';
import { createApp } from '../src/server.js';
import { MemoryStore } from '../src/memory-store.js';
import { loadBillingConfig } from '../src/billing.js';

const WEBHOOK_SECRET = 'whsec_test_secret';
const signer = new Stripe('sk_offline_signing_only');

let server;
let base;
let store;

before(async () => {
  store = new MemoryStore([]);
  server = createApp(store, {
    seedCount: 0,
    billing: loadBillingConfig({ STRIPE_SECRET_KEY: 'rk_test', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET })
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function deliver(event, { secret = WEBHOOK_SECRET, mangle = false } = {}) {
  const payload = JSON.stringify(event);
  let header = signer.webhooks.generateTestHeaderString({ payload, secret });
  if (mangle) header = header.replace(/v1=.{8}/, 'v1=00000000');
  return fetch(`${base}/api/stripe/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': header },
    body: payload
  });
}

const checkoutEvent = (id, created) => ({
  id,
  type: 'checkout.session.completed',
  created,
  data: {
    object: {
      id: 'cs_wh_1',
      payment_status: 'paid',
      customer: 'cus_webhook',
      subscription: 'sub_webhook',
      client_reference_id: 'team'
    }
  }
});

test('bad signature → 400, event never processed', async () => {
  const res = await deliver(checkoutEvent('evt_bad', 100), { mangle: true });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_signature');
  assert.equal(await store.findKeyByCustomer('cus_webhook'), null);
});

test('wrong secret → 400 (test vs live secret mixups fail loudly)', async () => {
  const res = await deliver(checkoutEvent('evt_wrong_secret', 100), { secret: 'whsec_other' });
  assert.equal(res.status, 400);
});

test('checkout.session.completed → pending_claim key with the tier plan', async () => {
  const res = await deliver(checkoutEvent('evt_ok_1', 100));
  assert.equal(res.status, 200);
  const key = await store.findKeyByCustomer('cus_webhook');
  assert.equal(key.status, 'pending_claim');
  assert.equal(key.plan, 'team');
});

test('duplicate event id is a no-op (idempotency)', async () => {
  const res = await deliver(checkoutEvent('evt_ok_1', 100));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).duplicate, true);
});

test('subscription.deleted → read_only + cancelled_at (grace window starts)', async () => {
  const res = await deliver({
    id: 'evt_cancel_1',
    type: 'customer.subscription.deleted',
    created: 300,
    data: { object: { customer: 'cus_webhook', status: 'canceled' } }
  });
  assert.equal(res.status, 200);
  const key = await store.findKeyByCustomer('cus_webhook');
  assert.equal(key.status, 'read_only');
  assert.ok(key.cancelledAt);
});

test('out-of-order: a stale subscription.updated cannot resurrect a cancelled key', async () => {
  const res = await deliver({
    id: 'evt_stale_1',
    type: 'customer.subscription.updated',
    created: 200, // older than the cancellation at created=300
    data: { object: { customer: 'cus_webhook', status: 'active', metadata: { tier: 'starter' } } }
  });
  assert.equal(res.status, 200);
  const key = await store.findKeyByCustomer('cus_webhook');
  assert.equal(key.status, 'read_only', 'stale event dropped by last_event_created guard');
  assert.equal(key.plan, 'team', 'stale plan change dropped too');
});

test('subscription.updated with newer created refreshes plan from subscription metadata', async () => {
  const res = await deliver({
    id: 'evt_fresh_1',
    type: 'customer.subscription.updated',
    created: 400,
    data: { object: { customer: 'cus_webhook', status: 'active', metadata: { tier: 'starter' } } }
  });
  assert.equal(res.status, 200);
  const key = await store.findKeyByCustomer('cus_webhook');
  assert.equal(key.status, 'active', 'reactivation clears read_only');
  assert.equal(key.plan, 'starter', 'tier travels on subscription metadata (OV-E4)');
  assert.equal(key.cancelledAt, null, 'reactivation clears cancelled_at');
});

test('unknown event types are ACKed (200), never an error loop', async () => {
  const res = await deliver({ id: 'evt_unknown', type: 'invoice.finalized', created: 500, data: { object: {} } });
  assert.equal(res.status, 200);
});

test('unsigned request → 400', async () => {
  const res = await fetch(`${base}/api/stripe/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(checkoutEvent('evt_unsigned', 600))
  });
  assert.equal(res.status, 400);
});
