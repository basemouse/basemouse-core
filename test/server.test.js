import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { test, before, after } from 'node:test';
import { createApp } from '../src/server.js';
import { loadBillingConfig } from '../src/billing.js';
import { loadLicenseConfig } from '../src/license.js';
import { createSeedRepository } from '../src/store.js';
import { MemoryStore } from '../src/memory-store.js';
import { hashKey, generateKey } from '../src/auth.js';

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

// --- canonical host (www -> bare host) --------------------------------------

// fetch() refuses to set Host (a forbidden header name), so these go out over
// raw http.request — the Host header is the entire point of the test.
function request(origin, { path = '/', method = 'GET', host, body, headers = {} } = {}) {
  const { port, hostname } = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: hostname, port, path, method, headers: { ...(host ? { host } : {}), ...headers } },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw }));
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function withCanonicalApp(run) {
  const app = createApp(createSeedRepository(), { canonicalHost: 'basemouse.com' });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = app.address();
    await run(`http://127.0.0.1:${port}`);
  } finally {
    app.close();
  }
}

test('308s www requests to the bare canonical host, preserving path and query', async () => {
  await withCanonicalApp(async (origin) => {
    const res = await request(origin, { path: '/blog/?utm_source=x', host: 'www.basemouse.com' });
    assert.equal(res.status, 308);
    assert.equal(res.headers.location, 'https://basemouse.com/blog/?utm_source=x');
  });
});

test('canonical redirect ignores the port on the Host header', async () => {
  await withCanonicalApp(async (origin) => {
    const res = await request(origin, { host: 'www.basemouse.com:8443' });
    assert.equal(res.status, 308);
    assert.equal(res.headers.location, 'https://basemouse.com/');
  });
});

test('canonical redirect leaves the bare host and unrelated hosts alone', async () => {
  await withCanonicalApp(async (origin) => {
    for (const host of ['basemouse.com', 'internal.example.com']) {
      const res = await request(origin, { host });
      assert.equal(res.status, 200, `${host} must be served, not redirected`);
    }
  });
});

test('canonical redirect never touches API/MCP writes on the www host', async () => {
  await withCanonicalApp(async (origin) => {
    // A 308 would make the client re-POST to a different origin; MCP must not move.
    const res = await request(origin, {
      path: '/mcp',
      method: 'POST',
      host: 'www.basemouse.com',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    assert.notEqual(res.status, 308);
    assert.equal(res.status, 401, 'www host must still serve MCP (401 without a token), never 308');
  });
});

test('canonical redirect is off unless a canonical host is configured', async () => {
  const res = await request(base, { host: 'www.basemouse.com' });
  assert.equal(res.status, 200);
});

test('canonical redirect covers HEAD, not just GET', async () => {
  await withCanonicalApp(async (origin) => {
    const res = await request(origin, { method: 'HEAD', host: 'www.basemouse.com' });
    assert.equal(res.status, 308);
    assert.equal(res.headers.location, 'https://basemouse.com/');
  });
});

test('canonical redirect honours x-forwarded-proto from the ingress', async () => {
  await withCanonicalApp(async (origin) => {
    // Traefik terminates TLS; without this the redirect would force https on a
    // plain-http hop and could loop. Comma-joined values take the first hop.
    const res = await request(origin, {
      host: 'www.basemouse.com',
      headers: { 'x-forwarded-proto': 'http, https' }
    });
    assert.equal(res.status, 308);
    assert.equal(res.headers.location, 'http://basemouse.com/');
  });
});

test('canonical host can be configured from the CANONICAL_HOST env var', async () => {
  const previous = process.env.CANONICAL_HOST;
  process.env.CANONICAL_HOST = 'basemouse.com';
  const app = createApp(createSeedRepository());
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = app.address();
    const res = await request(`http://127.0.0.1:${port}`, { host: 'www.basemouse.com' });
    assert.equal(res.status, 308);
    assert.equal(res.headers.location, 'https://basemouse.com/');
  } finally {
    app.close();
    if (previous === undefined) delete process.env.CANONICAL_HOST;
    else process.env.CANONICAL_HOST = previous;
  }
});

test('canonical redirect rejects a bogus x-forwarded-proto instead of reflecting it', async () => {
  await withCanonicalApp(async (origin) => {
    // A client-supplied header must never choose the Location scheme.
    const res = await request(origin, {
      host: 'www.basemouse.com',
      headers: { 'x-forwarded-proto': 'javascript' }
    });
    assert.equal(res.status, 308);
    assert.equal(res.headers.location, 'https://basemouse.com/');
  });
});

test('healthz and MCP serverInfo report the package.json version, not a hardcoded copy', async () => {
  // Regression: /healthz shipped the 0.3.0 release still reporting a hardcoded 0.2.0.
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  const health = await (await fetch(`${base}/healthz`)).json();
  assert.equal(health.version, version);

  const KEY = generateKey();
  const store = new MemoryStore(createSeedRepository());
  await store.createKey({ id: 'ws-ver', plan: 'demo', keyHash: hashKey(KEY) });
  const app = createApp(store);
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = app.address();
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${KEY}`
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.result.serverInfo.version, version);
  } finally {
    app.close();
  }
});
