import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createApp } from '../src/server.js';
import { loadBillingConfig } from '../src/billing.js';
import { loadLicenseConfig } from '../src/license.js';
import { createSeedRepository } from '../src/store.js';

let server;
let base;

before(async () => {
  server = createApp(createSeedRepository());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  base = `http://127.0.0.1:${port}`;
});

after(() => server.close());

test('healthz reports document count', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.documents >= 6);
});

test('healthz reports license/self-hosted posture and never leaks the key', async () => {
  // Dedicated app with an injected license config (key + tier + self-hosted).
  const licensed = createApp(createSeedRepository(), {
    license: loadLicenseConfig({
      BASEMOUSE_LICENSE_KEY: 'bml_should_not_appear',
      BASEMOUSE_LICENSE_TIER: 'enterprise',
      BASEMOUSE_SELF_HOSTED: 'true'
    })
  });
  await new Promise((resolve) => licensed.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = licensed.address();
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    const raw = await res.text();
    assert.ok(!raw.includes('bml_should_not_appear'), 'license key must never appear in healthz');
    const body = JSON.parse(raw);
    assert.equal(body.license.mode, 'self-hosted');
    assert.equal(body.license.tier, 'enterprise');
    assert.equal(body.license.licensed, true);
    assert.equal(Object.hasOwn(body.license, 'licenseKey'), false);
  } finally {
    licensed.close();
  }
});

test('responses carry security headers', async () => {
  const jsonRes = await fetch(`${base}/healthz`);
  assert.equal(jsonRes.headers.get('x-frame-options'), 'DENY');
  assert.equal(jsonRes.headers.get('x-content-type-options'), 'nosniff');
  assert.match(jsonRes.headers.get('content-security-policy'), /frame-ancestors 'none'/);

  const staticRes = await fetch(`${base}/`);
  assert.equal(staticRes.headers.get('x-frame-options'), 'DENY');
  assert.equal(staticRes.headers.get('x-content-type-options'), 'nosniff');
  assert.match(staticRes.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('directory requests serve the directory index.html', async () => {
  const withSlash = await fetch(`${base}/blog/`);
  assert.equal(withSlash.status, 200);
  assert.match(withSlash.headers.get('content-type'), /text\/html/);
  assert.match(await withSlash.text(), /<h1>Guides<\/h1>/);

  // The no-trailing-slash form resolves to the same index.html.
  const noSlash = await fetch(`${base}/blog`);
  assert.equal(noSlash.status, 200);
  assert.match(await noSlash.text(), /<h1>Guides<\/h1>/);
});

test('repository endpoint returns count + items', async () => {
  const res = await fetch(`${base}/api/repository`);
  const body = await res.json();
  assert.equal(body.count, body.items.length);
  assert.ok(body.items[0].checksum);
});

test('repository endpoint clamps an explicit limit=0 to the minimum of 1, not the default of 100', async () => {
  const res = await fetch(`${base}/api/repository?limit=0`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.limit, 1);
  assert.equal(body.items.length, 1);
});

test('search requires a query and validates length', async () => {
  assert.equal((await fetch(`${base}/api/search`)).status, 400);
  const long = 'x'.repeat(300);
  assert.equal((await fetch(`${base}/api/search?q=${long}`)).status, 400);

  const ok = await fetch(`${base}/api/search?q=agent`);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.ok(body.count >= 1);
});

test('context-pack validates the limit parameter', async () => {
  assert.equal((await fetch(`${base}/api/context-pack?limit=0`)).status, 400);
  assert.equal((await fetch(`${base}/api/context-pack?limit=abc`)).status, 400);

  const res = await fetch(`${base}/api/context-pack?q=memory&limit=2`);
  assert.equal(res.status, 200);
  const pack = await res.json();
  assert.equal(pack.schema, 'basemouse.context_pack.v1');
  assert.ok(pack.entries.length <= 2);
  assert.ok(pack.citations.length >= 1);
  assert.ok(Array.isArray(pack.relationships));
  assert.ok(pack.entries.every((entry) => Array.isArray(entry.links) && Array.isArray(entry.related)));
});

test('search filters results by type and echoes filters', async () => {
  const res = await fetch(`${base}/api/search?q=agent&type=feature`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.filters, { type: 'feature', tag: null });
  assert.ok(body.results.length >= 1);
  assert.ok(body.results.every((r) => r.type === 'feature'));
});

test('search rejects an overlong type filter with invalid_filter', async () => {
  const res = await fetch(`${base}/api/search?q=agent&type=${'x'.repeat(300)}`);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_filter');
});

test('search without filters echoes null filters and matches prior behavior', async () => {
  const res = await fetch(`${base}/api/search?q=agent`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.filters, { type: null, tag: null });
  assert.equal(body.count, body.results.length);
});

test('context-pack narrows entries by tag', async () => {
  const res = await fetch(`${base}/api/context-pack?tag=memory`);
  assert.equal(res.status, 200);
  const pack = await res.json();
  assert.equal(pack.filters.tag, 'memory');
  assert.ok(pack.entries.length >= 1);
  assert.ok(pack.entries.every((e) => e.tags.map((t) => t.toLowerCase()).includes('memory')));
});

test('context-pack rejects an overlong tag filter with invalid_filter', async () => {
  const res = await fetch(`${base}/api/context-pack?tag=${'x'.repeat(300)}`);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_filter');
});

test('search defaults to lexical retrieval and echoes the mode (back-compatible)', async () => {
  const res = await fetch(`${base}/api/search?q=agent`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.retrieval, 'lexical');
  // Lexical results carry no per-result retrieval metadata.
  assert.ok(body.results.every((r) => r.retrieval === undefined));
});

test('search accepts retrieval=lexical explicitly', async () => {
  const res = await fetch(`${base}/api/search?q=agent&retrieval=lexical`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).retrieval, 'lexical');
});

test('search supports retrieval=hybrid and annotates results with retrieval signals', async () => {
  const res = await fetch(`${base}/api/search?q=memory&retrieval=hybrid`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.retrieval, 'hybrid');
  assert.ok(body.results.length >= 1);
  assert.ok(body.results.every((r) => r.retrieval && r.retrieval.mode === 'hybrid'));
  assert.ok(body.results.some((r) => r.retrieval.signals?.includes('graph')), 'hybrid pulls in a graph neighbor');
});

test('search rejects an invalid retrieval value with invalid_retrieval', async () => {
  const res = await fetch(`${base}/api/search?q=agent&retrieval=semantic`);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_retrieval');
});

test('context-pack defaults to lexical retrieval', async () => {
  const res = await fetch(`${base}/api/context-pack?q=memory&limit=2`);
  assert.equal(res.status, 200);
  const pack = await res.json();
  assert.equal(pack.retrieval.mode, 'lexical');
  assert.ok(pack.entries.every((e) => e.retrieval?.mode === 'lexical'));
});

test('context-pack supports retrieval=hybrid and returns entry retrieval metadata', async () => {
  const res = await fetch(`${base}/api/context-pack?q=memory&retrieval=hybrid&limit=10`);
  assert.equal(res.status, 200);
  const pack = await res.json();
  assert.equal(pack.retrieval.mode, 'hybrid');
  assert.ok(pack.entries.length >= 1);
  assert.ok(pack.entries.every((e) => e.retrieval && e.retrieval.mode === 'hybrid'));
  assert.ok(pack.entries.some((e) => e.retrieval.signals?.includes('graph')), 'hybrid pack includes a graph-expanded entry');
});

test('context-pack rejects an invalid retrieval value with invalid_retrieval', async () => {
  const res = await fetch(`${base}/api/context-pack?retrieval=semantic`);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'invalid_retrieval');
});

test('hybrid search includes local vector signals and a vector backend block', async () => {
  const res = await fetch(`${base}/api/search?q=memory%20capsules&retrieval=hybrid`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.vector.backend, 'local-hashed');
  assert.ok(Number.isInteger(body.vector.dimensions) && body.vector.dimensions > 0);
  // At least one result is surfaced (also) by the local vector signal, and that
  // signal is reported distinctly from lexical/graph.
  const vectorHit = body.results.find((r) => r.retrieval.signals.includes('vector'));
  assert.ok(vectorHit, 'a result carries a vector signal');
  assert.ok(vectorHit.retrieval.sourceScores.vector > 0);
  // Lexical-only search never reports a vector backend block.
  const lexical = await (await fetch(`${base}/api/search?q=memory&retrieval=lexical`)).json();
  assert.equal(lexical.vector, null);
});

test('hybrid context-pack includes local vector signals and backend metadata', async () => {
  const res = await fetch(`${base}/api/context-pack?q=memory%20capsules&retrieval=hybrid&limit=10`);
  assert.equal(res.status, 200);
  const pack = await res.json();
  assert.equal(pack.retrieval.vector.backend, 'local-hashed');
  assert.ok(pack.retrieval.signals.includes('vector'), 'pack summary lists the vector signal');
  assert.ok(pack.entries.some((e) => e.retrieval.signals.includes('vector')), 'an entry carries a vector signal');
});

test('hybrid context-pack with no query stays lexical and omits the vector block', async () => {
  // retrieval=hybrid without a query has nothing to rank, so the pack falls back
  // to lexical mode; the vector block must not claim the backend ran.
  const res = await fetch(`${base}/api/context-pack?retrieval=hybrid&limit=5`);
  assert.equal(res.status, 200);
  const pack = await res.json();
  assert.equal(pack.retrieval.mode, 'lexical');
  assert.equal(pack.retrieval.weights, null);
  assert.equal(pack.retrieval.vector, undefined, 'no vector block on a query-less lexical pack');
});

test('BASEMOUSE_VECTOR_RETRIEVAL=off disables vector signals but keeps graph hybrid', async () => {
  const prev = process.env.BASEMOUSE_VECTOR_RETRIEVAL;
  process.env.BASEMOUSE_VECTOR_RETRIEVAL = 'off';
  try {
    const body = await (await fetch(`${base}/api/search?q=memory%20capsules&retrieval=hybrid`)).json();
    assert.equal(body.vector, null, 'no vector backend block when disabled');
    assert.ok(body.results.every((r) => !r.retrieval.signals.includes('vector')), 'no vector signals');
    assert.ok(body.results.some((r) => r.retrieval.signals.includes('graph')), 'graph hybrid still works');
  } finally {
    if (prev === undefined) delete process.env.BASEMOUSE_VECTOR_RETRIEVAL;
    else process.env.BASEMOUSE_VECTOR_RETRIEVAL = prev;
  }
});

test('non-GET methods are rejected', async () => {
  const res = await fetch(`${base}/api/repository`, { method: 'POST' });
  assert.equal(res.status, 405);
});

test('unknown api routes 404', async () => {
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
});

test('billing config endpoint is browser-safe when Stripe is not configured', async () => {
  const res = await fetch(`${base}/api/billing/config`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const serialized = JSON.stringify(body);

  assert.equal(body.enabled, false);
  assert.ok(Array.isArray(body.tiers));
  assert.doesNotMatch(serialized, /STRIPE_SECRET|price_/);
});

test('checkout endpoint returns disabled state without Stripe configuration', async () => {
  const res = await fetch(`${base}/api/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tier: 'starter' })
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error, 'billing_disabled');
  assert.match(body.message, /Billing is not configured/);
});

test('checkout endpoint validates content type and payload shape', async () => {
  assert.equal((await fetch(`${base}/api/checkout`, { method: 'POST' })).status, 415);

  const malformed = await fetch(`${base}/api/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{'
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, 'invalid_json');

  const missingTier = await fetch(`${base}/api/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(missingTier.status, 400);
  assert.equal((await missingTier.json()).error, 'invalid_request');
});

test('checkout endpoint uses injected Stripe session creator when billing is enabled', async () => {
  const checkoutServer = createApp(createSeedRepository(), {
    billing: loadBillingConfig({
      CHECKOUT_ENABLED: 'true',
      STRIPE_SECRET_KEY: 'rk_test_restricted',
      STRIPE_PRICE_STARTER: 'price_starter'
    }),
    createCheckoutSession: async (_billing, tier) => ({
      url: `https://checkout.stripe.test/${tier}`,
      id: 'cs_test'
    })
  });
  await new Promise((resolve) => checkoutServer.listen(0, '127.0.0.1', resolve));
  const { port } = checkoutServer.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'starter' })
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { url: 'https://checkout.stripe.test/starter', tier: 'starter' });
  } finally {
    await new Promise((resolve) => checkoutServer.close(resolve));
  }
});

test('serves static index for /', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /BaseMouse/);
});

test('blocks path traversal attempts', async () => {
  for (const attack of [
    '/../package.json',
    '/..%2f..%2fpackage.json',
    '/%2e%2e/%2e%2e/src/server.js'
  ]) {
    const res = await fetch(`${base}${attack}`, { redirect: 'manual' });
    assert.ok(res.status === 403 || res.status === 404, `${attack} -> ${res.status}`);
    const text = await res.text();
    assert.doesNotMatch(text, /"name": "basemouse"/, `leaked package.json via ${attack}`);
  }
});

test('malformed encoded paths return 400 without leaking internals', async () => {
  const res = await fetch(`${base}/%E0%A4%A`, { redirect: 'manual' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'bad_request');
  assert.equal(Object.hasOwn(body, 'message'), false);
});

test('missing static asset returns 404', async () => {
  assert.equal((await fetch(`${base}/does-not-exist.js`)).status, 404);
});

test('serves the SVG favicon with the right content type', async () => {
  const res = await fetch(`${base}/favicon.svg`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
  const body = await res.text();
  assert.match(body, /<svg/);
});

test('index links the favicon and the API quickstart anchor', async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /rel="icon"[^>]*\/favicon\.svg/);
  assert.match(html, /id="api"/);
});

test('serves the agent governance demo page from the homepage', async () => {
  const home = await (await fetch(`${base}/`)).text();
  assert.match(home, /href="\/agent-governance-demo\.html"/);

  const res = await fetch(`${base}/agent-governance-demo.html`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /Agent Governance Demo/);
  assert.match(html, /20\/20 golden queries/);
  assert.match(html, /OpenTelemetry evidence span/);
});

test('serves the design partner intake page from the homepage', async () => {
  const home = await (await fetch(`${base}/`)).text();
  assert.match(home, /href="\/design-partner\.html"/);

  const res = await fetch(`${base}/design-partner.html`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /Design Partner Intake/);
  assert.match(html, /Bring us your messy docs/);
  assert.match(html, /20–100 docs/);
  assert.match(html, /devsupport@basemouse\.com/);
});
