import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createCheckoutSession,
  findTier,
  loadBillingConfig,
  publicBillingConfig
} from '../src/billing.js';

test('billing config is disabled without Stripe secrets and price IDs', () => {
  const config = loadBillingConfig({});

  assert.equal(config.enabled, false);
  assert.equal(config.secretKey, null);
  assert.ok(config.tiers.length >= 3);
  assert.ok(config.tiers.every((tier) => tier.checkout === false));
});

test('checkout stays disabled without CHECKOUT_ENABLED even with full Stripe config', () => {
  const config = loadBillingConfig({
    STRIPE_SECRET_KEY: 'rk_test_restricted',
    STRIPE_PRICE_STARTER: 'price_starter',
    STRIPE_PRICE_TEAM: 'price_team',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_public'
  });

  assert.equal(config.enabled, false);
  assert.ok(config.tiers.every((tier) => tier.checkout === false));
  const projected = publicBillingConfig(config);
  // No tier can start Stripe Checkout; paid tiers fall back to contact-sales
  // and the open-core tier links out to GitHub/docs.
  assert.ok(projected.tiers.every((tier) => tier.action !== 'checkout'));
  assert.ok(projected.tiers.filter((tier) => tier.id !== 'open').every((tier) => tier.action === 'contact'));
});

test('open-source tier links out to GitHub/docs and never touches Stripe', () => {
  // Even with full self-serve config, the open-core tier must not be purchasable.
  const config = loadBillingConfig({
    CHECKOUT_ENABLED: 'true',
    STRIPE_SECRET_KEY: 'rk_test_restricted',
    STRIPE_PRICE_STARTER: 'price_starter',
    STRIPE_PRICE_TEAM: 'price_team',
    OPEN_SOURCE_URL: 'https://github.com/basemouse/basemouse'
  });

  const open = findTier(config, 'open');
  assert.ok(open, 'open tier exists in the catalog');
  assert.equal(open.checkout, false);
  assert.equal(open.openSource, true);
  assert.equal(open.priceId, null);
  assert.equal(open.price, '$0');

  const projected = publicBillingConfig(config);
  const openPublic = projected.tiers.find((tier) => tier.id === 'open');
  assert.equal(openPublic.action, 'link');
  assert.equal(openPublic.actionUrl, 'https://github.com/basemouse/basemouse');
  assert.ok(openPublic.actionLabel && openPublic.actionLabel.length > 0);
});

test('open-source CTA defaults to the real repo, never the stale demo, when no env override is set', () => {
  // The public billing config must ship the canonical repo URL out of the box so
  // a fresh deploy with no OPEN_SOURCE_URL override never points users at a
  // non-existent basemouse-demo repo.
  const projected = publicBillingConfig(loadBillingConfig({}));
  const open = projected.tiers.find((tier) => tier.id === 'open');
  assert.equal(open.action, 'link');
  assert.equal(open.actionUrl, 'https://github.com/basemouse/basemouse');
  assert.equal(projected.openSourceUrl, 'https://github.com/basemouse/basemouse');
  assert.doesNotMatch(open.actionUrl, /basemouse-demo/);
});

test('createCheckoutSession refuses the open-source tier even with checkout enabled', async () => {
  const config = loadBillingConfig({
    CHECKOUT_ENABLED: 'true',
    STRIPE_SECRET_KEY: 'rk_test_restricted',
    STRIPE_PRICE_STARTER: 'price_starter',
    STRIPE_PRICE_TEAM: 'price_team'
  });
  let called = false;

  await assert.rejects(
    createCheckoutSession(config, 'open', {
      fetchImpl: async () => {
        called = true;
      }
    }),
    /tier_not_purchasable/
  );
  assert.equal(called, false);
});

test('tier copy does not claim GraphRAG is implemented today', () => {
  const config = loadBillingConfig({});
  const allFeatures = config.tiers.flatMap((tier) => tier.features).join(' ');
  // The server ships graph-aware relationships, not GraphRAG — copy must match.
  assert.doesNotMatch(allFeatures, /graphrag/i);
});

test('tier copy never advertises unlimited or unenforced limits', async () => {
  const config = loadBillingConfig({});
  const allFeatures = config.tiers.flatMap((tier) => tier.features).join(' ');

  assert.doesNotMatch(allFeatures, /unlimited/i);

  // The copy must match the EFFECTIVE enforced limits (including any
  // PLAN_LIMITS_JSON override in this environment) — marketing can never
  // drift from enforcement again (design doc OV-E1.6).
  const { loadPlanLimits } = await import('../src/quota.js');
  const limits = loadPlanLimits();
  const fmt = (n) => n.toLocaleString('en-US');
  assert.match(allFeatures, new RegExp(`Up to ${fmt(limits.starter.maxDocuments)} documents`));
  assert.match(allFeatures, new RegExp(`Up to ${fmt(limits.team.maxDocuments)} documents`));
});

test('billing config enables checkout only for tiers with secret key and price ID', () => {
  const config = loadBillingConfig({
    CHECKOUT_ENABLED: 'true',
    STRIPE_SECRET_KEY: 'rk_test_restricted',
    STRIPE_PRICE_STARTER: 'price_starter',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_public'
  });

  assert.equal(config.enabled, true);
  assert.equal(findTier(config, 'starter').checkout, true);
  assert.equal(findTier(config, 'team').checkout, false);
  assert.equal(findTier(config, 'enterprise').checkout, false);
});

test('public billing config strips Stripe secret key and price IDs', () => {
  const config = loadBillingConfig({
    CHECKOUT_ENABLED: 'true',
    STRIPE_SECRET_KEY: 'secret_key_sentinel',
    STRIPE_PRICE_STARTER: 'price_starter_secret',
    STRIPE_PRICE_TEAM: 'price_team_secret',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_public'
  });

  const projected = publicBillingConfig(config);
  const serialized = JSON.stringify(projected);

  assert.equal(projected.enabled, true);
  assert.equal(projected.publishableKey, 'pk_test_public');
  assert.doesNotMatch(serialized, /secret_key_sentinel/);
  assert.doesNotMatch(serialized, /price_starter_secret/);
  assert.doesNotMatch(serialized, /price_team_secret/);
  assert.equal(projected.tiers.find((tier) => tier.id === 'starter').action, 'checkout');
});

test('full self-serve config makes both Starter and Team purchasable', () => {
  const config = loadBillingConfig({
    CHECKOUT_ENABLED: 'true',
    STRIPE_SECRET_KEY: 'rk_test_restricted',
    STRIPE_PRICE_STARTER: 'price_starter',
    STRIPE_PRICE_TEAM: 'price_team'
  });

  assert.equal(config.enabled, true);
  assert.equal(findTier(config, 'starter').checkout, true);
  assert.equal(findTier(config, 'team').checkout, true);
  // Enterprise is contact-sales only (priceEnv: null) and never purchasable.
  assert.equal(findTier(config, 'enterprise').checkout, false);

  const projected = publicBillingConfig(config);
  assert.equal(projected.tiers.find((tier) => tier.id === 'starter').action, 'checkout');
  assert.equal(projected.tiers.find((tier) => tier.id === 'team').action, 'checkout');
  assert.equal(projected.tiers.find((tier) => tier.id === 'enterprise').action, 'contact');
});

test('webhook secret is loaded server-side and never reaches the browser projection', () => {
  const config = loadBillingConfig({
    CHECKOUT_ENABLED: 'true',
    STRIPE_SECRET_KEY: 'rk_test_restricted',
    STRIPE_PRICE_STARTER: 'price_starter',
    STRIPE_WEBHOOK_SECRET: 'whsec_sentinel'
  });

  // The webhook handler needs the signing secret server-side...
  assert.equal(config.webhookSecret, 'whsec_sentinel');

  // ...but it must never leak through the public config the browser receives.
  const serialized = JSON.stringify(publicBillingConfig(config));
  assert.doesNotMatch(serialized, /whsec_sentinel/);
});

test('createCheckoutSession posts subscription checkout request without payment_method_types', async () => {
  const config = loadBillingConfig({
    CHECKOUT_ENABLED: 'true',
    STRIPE_SECRET_KEY: 'rk_test_restricted',
    STRIPE_PRICE_STARTER: 'price_starter',
    BILLING_SUCCESS_URL: 'https://basemouse.com/success',
    BILLING_CANCEL_URL: 'https://basemouse.com/cancel'
  });

  const calls = [];
  const result = await createCheckoutSession(config, 'starter', {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        json: async () => ({ id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/cs_test_123' })
      };
    }
  });

  assert.equal(result.url, 'https://checkout.stripe.com/c/pay/cs_test_123');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer rk_test_restricted');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/x-www-form-urlencoded');

  const params = new URLSearchParams(calls[0].options.body);
  assert.equal(params.get('mode'), 'subscription');
  assert.equal(params.get('line_items[0][price]'), 'price_starter');
  assert.equal(params.get('success_url'), 'https://basemouse.com/success');
  assert.equal(params.get('cancel_url'), 'https://basemouse.com/cancel');
  assert.equal(params.has('payment_method_types'), false);
});

test('createCheckoutSession rejects disabled or non-purchasable tiers before calling Stripe', async () => {
  const config = loadBillingConfig({});
  let called = false;

  await assert.rejects(
    createCheckoutSession(config, 'starter', {
      fetchImpl: async () => {
        called = true;
      }
    }),
    /billing_disabled/
  );

  assert.equal(called, false);
});
