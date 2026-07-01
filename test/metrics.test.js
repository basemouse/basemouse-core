// Operability kit tests: counters move with real traffic, /metrics renders
// Prometheus text format, the pack-checksum header ships, and the alert
// checker fires on its two conditions — with an injectable clock (no sleeps)
// and an injectable webhook fetch (no network).

import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createApp } from '../src/server.js';
import { MemoryStore } from '../src/memory-store.js';
import { createSeedRepository } from '../src/store.js';
import { createMetrics, runAlertChecks } from '../src/metrics.js';

const seeds = createSeedRepository();
let server;
let base;

before(async () => {
  server = createApp(new MemoryStore(seeds), { seedCount: seeds.length });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('pack pulls move the counter and the response carries the checksum header', async () => {
  const res = await fetch(`${base}/api/context-pack?q=agent&limit=2`);
  assert.equal(res.status, 200);
  const checksum = res.headers.get('x-basemouse-pack-checksum');
  assert.match(checksum, /^[0-9a-f]{16}$/);

  const metricsRes = await fetch(`${base}/metrics`);
  assert.equal(metricsRes.status, 200);
  assert.match(metricsRes.headers.get('content-type'), /text\/plain/);
  const text = await metricsRes.text();
  assert.match(text, /basemouse_pack_pulls [1-9]/);
  assert.match(text, /basemouse_search_path_scan [1-9]/);
  assert.match(text, /basemouse_degraded 0/);
  assert.match(text, /basemouse_uptime_seconds \d/);
});

test('openapi spec serves at /api/openapi.json', async () => {
  const res = await fetch(`${base}/api/openapi.json`);
  assert.equal(res.status, 200);
  const spec = await res.json();
  assert.equal(spec.openapi, '3.1.0');
  assert.ok(spec.paths['/api/context-pack']);
  assert.ok(spec.paths['/mcp']);
});

test('alert checker: degraded >5m fires once, clears, and can fire again', async () => {
  let clock = 1_000_000;
  const now = () => clock;
  const metrics = createMetrics({ now });
  const posts = [];
  const fetchImpl = async (url, opts) => { posts.push({ url, body: opts.body }); return { ok: true }; };
  const opts = { webhookUrl: 'https://ntfy.example/basemouse', fetchImpl, now };

  metrics.setDegraded(true);
  clock += 4 * 60_000;
  assert.deepEqual(await runAlertChecks(metrics, opts), [], 'under 5m — silent');

  clock += 2 * 60_000;
  const fired = await runAlertChecks(metrics, opts);
  assert.equal(fired.length, 1);
  assert.match(fired[0], /degraded/);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body, fired[0], 'plain-text body for non-Slack webhooks');

  clock += 60_000;
  assert.deepEqual(await runAlertChecks(metrics, opts), [], 'refractory — one alert per incident');

  metrics.setDegraded(false);
  await runAlertChecks(metrics, opts);
  metrics.setDegraded(true);
  clock += 6 * 60_000;
  assert.equal((await runAlertChecks(metrics, opts)).length, 1, 'new incident fires again');
  assert.equal(metrics.counters.degraded_activations, 2);
});

test('alert checker: claim-failure spike fires at 5 within 10 minutes', async () => {
  let clock = 5_000_000;
  const now = () => clock;
  const metrics = createMetrics({ now });
  const opts = { webhookUrl: null, now }; // no webhook — fired list still returns

  for (let i = 0; i < 4; i++) metrics.recordClaimFailure();
  assert.deepEqual(await runAlertChecks(metrics, opts), [], '4 failures — silent');

  metrics.recordClaimFailure();
  const fired = await runAlertChecks(metrics, opts);
  assert.equal(fired.length, 1);
  assert.match(fired[0], /claim/);

  // Failures age out of the 10-minute window; the alert re-arms.
  clock += 11 * 60_000;
  metrics.recordClaimFailure();
  assert.deepEqual(await runAlertChecks(metrics, opts), [], 'window slid — back under threshold');
});

test('slack-shaped webhooks get JSON {text}', async () => {
  let clock = 9_000_000;
  const now = () => clock;
  const metrics = createMetrics({ now });
  const posts = [];
  const fetchImpl = async (url, opts) => { posts.push(opts); return { ok: true }; };

  metrics.setDegraded(true);
  clock += 6 * 60_000;
  await runAlertChecks(metrics, { webhookUrl: 'https://hooks.slack.com/services/T/B/x', fetchImpl, now });
  assert.equal(posts[0].headers['Content-Type'], 'application/json');
  assert.ok(JSON.parse(posts[0].body).text);
});

test('alert delivery failure never throws into the caller', async () => {
  let clock = 12_000_000;
  const now = () => clock;
  const metrics = createMetrics({ now });
  metrics.setDegraded(true);
  clock += 6 * 60_000;
  const fired = await runAlertChecks(metrics, {
    webhookUrl: 'https://ntfy.example/x',
    fetchImpl: async () => { throw new Error('network down'); },
    now
  });
  assert.equal(fired.length, 1, 'alert recorded even when delivery fails');
});
