// Degraded demo-fallback tests (design decision 1A + OV1.1): when Postgres is
// unreachable, anonymous reads serve the in-repo seed corpus with an explicit
// X-BaseMouse-Degraded header, authenticated reads get the registry's 503,
// and /readyz reports ready (200) with degraded:true so k8s never pulls the
// pod that could still serve the demo.

import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createApp } from '../src/server.js';
import { MemoryStore } from '../src/memory-store.js';
import { createSeedRepository } from '../src/store.js';
import { StoreUnavailableError } from '../src/errors.js';
import { generateKey, hashKey } from '../src/auth.js';
import { currentMonth } from '../src/quota.js';

const seeds = createSeedRepository();

// A store whose every call fails the way a dead Postgres fails.
function deadStore() {
  const fail = async () => {
    throw new StoreUnavailableError(new Error('connection refused'));
  };
  return {
    ping: fail,
    listVisible: fail,
    getDocument: fail,
    createDocument: fail,
    updateDocument: fail,
    deleteDocument: fail,
    getHistory: fail,
    findKeyByHash: fail,
    createKey: fail,
    ensureSeeds: fail
  };
}

let server;
let base;

before(async () => {
  server = createApp(deadStore(), {
    fallbackStore: new MemoryStore(seeds),
    seedCount: seeds.length
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('anonymous search degrades to the seed corpus with an explicit header', async () => {
  const res = await fetch(`${base}/api/search?q=agent`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-basemouse-degraded'), 'true');
  const body = await res.json();
  assert.ok(body.results.length > 0, 'the demo keeps answering');
});

test('anonymous context pack degrades and labels its provenance', async () => {
  const res = await fetch(`${base}/api/context-pack?q=agent&limit=2`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-basemouse-degraded'), 'true');
  const pack = await res.json();
  assert.equal(pack.corpus, 'demo-fallback', 'degraded packs never impersonate live-store provenance');
});

test('authenticated reads do NOT silently degrade — 503 with Retry-After', async () => {
  const res = await fetch(`${base}/api/search?q=agent`, {
    headers: { Authorization: `Bearer ${generateKey()}` }
  });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'service_unavailable');
  assert.ok(res.headers.get('retry-after'));
});

test('writes during an outage are 503, never queued or dropped silently', async () => {
  const res = await fetch(`${base}/api/documents`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${generateKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'x', title: 'x', body: 'y' })
  });
  assert.equal(res.status, 503);
});

test('a load failure during context-pack never burns the plan quota (metered only after a successful load)', async () => {
  const outageStore = new MemoryStore([]);
  const testKey = generateKey();
  await outageStore.createKey({ id: 'ws-outage', plan: 'demo', keyHash: hashKey(testKey) });

  let recordPackPullCalls = 0;
  const realRecordPackPull = outageStore.recordPackPull.bind(outageStore);
  outageStore.recordPackPull = async (...args) => {
    recordPackPullCalls += 1;
    return realRecordPackPull(...args);
  };
  // Auth (findKeyByHash) succeeds, but the document load itself fails —
  // e.g. a read replica down while the keys table is still reachable.
  outageStore.listVisible = async () => {
    throw new StoreUnavailableError(new Error('read replica down'));
  };

  const outageApp = createApp(outageStore, { seedCount: 0 });
  await new Promise((resolve) => outageApp.listen(0, '127.0.0.1', resolve));
  const outageBase = `http://127.0.0.1:${outageApp.address().port}`;
  try {
    const res = await fetch(`${outageBase}/api/context-pack?q=agent`, {
      headers: { Authorization: `Bearer ${testKey}` }
    });
    assert.equal(res.status, 503);
    assert.equal(recordPackPullCalls, 0, 'a pack that was never delivered must never be metered');
    const usage = await outageStore.getUsage('ws-outage', currentMonth());
    assert.equal(usage.packPulls, 0);
  } finally {
    await new Promise((resolve) => outageApp.close(resolve));
  }
});

test('/readyz reports ready (200) with degraded:true so the demo pod stays in the Service', async () => {
  const res = await fetch(`${base}/readyz`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ready, true);
  assert.equal(body.degraded, true);
});

test('/healthz stays process-only and never touches the store', async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test('without a fallback store, /readyz fails closed (503)', async () => {
  const bare = createApp(deadStore(), { seedCount: 0 });
  await new Promise((resolve) => bare.listen(0, '127.0.0.1', resolve));
  const port = bare.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/readyz`);
    assert.equal(res.status, 503);
  } finally {
    await new Promise((resolve) => bare.close(resolve));
  }
});
