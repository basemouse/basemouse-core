#!/usr/bin/env node
// Post-deploy smoke test (design decision 9A): healthz, readyz, search, pack
// pull, and one write→tombstone round trip with a dedicated smoke key.
// Pass/fail in under 60 seconds; exit 0 = deploy is good.
//
//   node scripts/smoke.mjs --base-url https://basemouse.com
//   BASEMOUSE_SMOKE_KEY=bm_... node scripts/smoke.mjs --base-url ...   (adds write round trip)

import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: { 'base-url': { type: 'string', default: 'http://localhost:3000' } }
});
const base = values['base-url'].replace(/\/$/, '');
const smokeKey = process.env.BASEMOUSE_SMOKE_KEY || null;

const checks = [];
async function check(name, fn) {
  const startedAt = Date.now();
  try {
    await fn();
    checks.push({ name, ok: true, ms: Date.now() - startedAt });
  } catch (error) {
    checks.push({ name, ok: false, ms: Date.now() - startedAt, error: error.message });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// GETs are idempotent, so retry transient network/timeout errors: a single
// connection blip during a rollout (e.g. a first-request TLS reset before the
// new pod is steady in the ingress) should not fail the whole deploy. Only
// thrown errors (fetch failed / TimeoutError) are retried — an HTTP status is
// returned as-is so a genuine 5xx still fails the check.
const get = async (path, headers = {}) => {
  const attempts = 3;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(750 * attempt);
    }
  }
  throw lastError;
};

await check('healthz', async () => {
  const res = await get('/healthz');
  if (res.status !== 200) throw new Error(`status ${res.status}`);
});

await check('readyz', async () => {
  const res = await get('/readyz');
  const body = await res.json();
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  if (body.degraded) throw new Error('store is in degraded fallback mode');
});

await check('search', async () => {
  const res = await get('/api/search?q=agent');
  const body = await res.json();
  if (res.status !== 200 || !Array.isArray(body.results)) throw new Error(`status ${res.status}`);
});

await check('context-pack', async () => {
  const res = await get('/api/context-pack?q=agent&limit=2');
  const body = await res.json();
  if (res.status !== 200 || !Array.isArray(body.entries)) throw new Error(`status ${res.status}`);
});

if (smokeKey) {
  const headers = { Authorization: `Bearer ${smokeKey}`, 'Content-Type': 'application/json' };
  const id = `smoke-${Date.now().toString(36)}`;
  await check('write→tombstone round trip', async () => {
    const created = await fetch(`${base}/api/documents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id, title: 'smoke test', body: 'deploy verification document', type: 'note' }),
      signal: AbortSignal.timeout(10_000)
    });
    if (created.status !== 201) throw new Error(`create: status ${created.status}`);
    const deleted = await fetch(`${base}/api/documents/${id}`, {
      method: 'DELETE',
      headers,
      signal: AbortSignal.timeout(10_000)
    });
    if (deleted.status !== 200) throw new Error(`tombstone: status ${deleted.status}`);
  });
} else {
  checks.push({ name: 'write→tombstone round trip', ok: true, ms: 0, skipped: 'no BASEMOUSE_SMOKE_KEY set' });
}

let failed = 0;
for (const c of checks) {
  const status = c.ok ? (c.skipped ? 'SKIP' : ' OK ') : 'FAIL';
  console.log(`[${status}] ${c.name} (${c.ms}ms)${c.error ? ` — ${c.error}` : ''}${c.skipped ? ` — ${c.skipped}` : ''}`);
  if (!c.ok) failed += 1;
}
console.log(failed === 0 ? '\nsmoke: PASS' : `\nsmoke: FAIL (${failed} check${failed === 1 ? '' : 's'})`);
process.exit(failed === 0 ? 0 : 1);
