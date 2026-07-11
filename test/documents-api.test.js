// HTTP-level tests for the M1 write path and scoped reads: every shadow path
// (nil/empty/upstream-error) plus auth scoping and the R1 repository
// pagination contract.

import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createApp } from '../src/server.js';
import { MemoryStore } from '../src/memory-store.js';
import { createSeedRepository } from '../src/store.js';
import { hashKey, generateKey } from '../src/auth.js';

const seeds = createSeedRepository();
const KEY_A = generateKey();
const KEY_B = generateKey();
const KEY_REVOKED = generateKey();

let server;
let base;
let store;

before(async () => {
  store = new MemoryStore(seeds);
  await store.createKey({ id: 'ws-a', plan: 'demo', keyHash: hashKey(KEY_A) });
  await store.createKey({ id: 'ws-b', plan: 'demo', keyHash: hashKey(KEY_B) });
  const revoked = await store.createKey({ id: 'ws-r', plan: 'demo', keyHash: hashKey(KEY_REVOKED) });
  store.keys.get(revoked.id).status = 'revoked';

  server = createApp(store, { seedCount: seeds.length });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const authed = (key) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' });

test('POST /api/documents requires a key (anonymous → 401)', async () => {
  const res = await fetch(`${base}/api/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'nope', title: 'x', body: 'y' })
  });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'unauthorized');
});

test('malformed bearer and revoked keys are rejected loudly', async () => {
  const malformed = await fetch(`${base}/api/documents`, {
    method: 'POST',
    headers: { Authorization: 'Bearer not-a-key', 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(malformed.status, 401);

  const revoked = await fetch(`${base}/api/documents`, {
    method: 'POST',
    headers: authed(KEY_REVOKED),
    body: JSON.stringify({ id: 'nope', title: 'x', body: 'y' })
  });
  assert.equal(revoked.status, 401);
});

// Regression guard for the operator off-switch (plan-eng-review T6): proves
// setKeyStatus actually flows through to auth enforcement end-to-end, so a
// future refactor of either setKeyStatus or auth.js can't silently decouple
// them. Uses a dedicated key so it doesn't disturb the shared fixtures.
test('off-switch: setKeyStatus drives read_only (403) and revoked (401) end-to-end', async () => {
  const KEY_SW = generateKey();
  const k = await store.createKey({ id: 'ws-sw', plan: 'starter', keyHash: hashKey(KEY_SW) });
  const writeDoc = (id) => fetch(`${base}/api/documents`, {
    method: 'POST',
    headers: authed(KEY_SW),
    body: JSON.stringify({ id, title: 't', body: 'b' })
  });

  const active = await writeDoc('sw-1');
  assert.ok(active.ok, `active key writes (got ${active.status})`);

  await store.setKeyStatus(k.id, 'read_only', 'test');
  const frozen = await writeDoc('sw-2');
  assert.equal(frozen.status, 403, 'read_only key cannot write');
  assert.equal((await frozen.json()).error, 'read_only_key');
  const stillReads = await fetch(`${base}/api/repository`, { headers: authed(KEY_SW) });
  assert.equal(stillReads.status, 200, 'read_only key still reads');

  await store.setKeyStatus(k.id, 'revoked', 'test');
  const killed = await writeDoc('sw-3');
  assert.equal(killed.status, 401, 'revoked key is rejected at auth');

  await store.setKeyStatus(k.id, 'active', 'test');
  const back = await writeDoc('sw-4');
  assert.ok(back.ok, `reactivated key writes again (got ${back.status})`);
});

test('create → read → update (optimistic lock) → tombstone → history → resurrect', async () => {
  const created = await fetch(`${base}/api/documents`, {
    method: 'POST',
    headers: authed(KEY_A),
    body: JSON.stringify({ id: 'runbook', title: 'Runbook', body: 'Step one.', type: 'note', tags: ['ops'] })
  });
  assert.equal(created.status, 201);
  const doc = await created.json();
  assert.equal(doc.version, 1);
  assert.ok(doc.checksum);

  // Duplicate id in the same workspace → 409.
  const dup = await fetch(`${base}/api/documents`, {
    method: 'POST',
    headers: authed(KEY_A),
    body: JSON.stringify({ id: 'runbook', title: 'Again', body: 'x' })
  });
  assert.equal(dup.status, 409);
  assert.equal((await dup.json()).error, 'duplicate_id');

  // Update without expectedVersion → 400; with stale version → 409 carrying current.
  const noVersion = await fetch(`${base}/api/documents/runbook`, {
    method: 'PUT',
    headers: authed(KEY_A),
    body: JSON.stringify({ title: 'Runbook v2' })
  });
  assert.equal(noVersion.status, 400);

  const updated = await fetch(`${base}/api/documents/runbook`, {
    method: 'PUT',
    headers: authed(KEY_A),
    body: JSON.stringify({ title: 'Runbook v2', expectedVersion: 1 })
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).version, 2);

  const stale = await fetch(`${base}/api/documents/runbook`, {
    method: 'PUT',
    headers: authed(KEY_A),
    body: JSON.stringify({ title: 'Stale', expectedVersion: 1 })
  });
  assert.equal(stale.status, 409);
  const staleBody = await stale.json();
  assert.equal(staleBody.error, 'version_conflict');
  assert.equal(staleBody.currentVersion, 2);

  // Tombstone; document leaves search but history stays.
  const deleted = await fetch(`${base}/api/documents/runbook`, { method: 'DELETE', headers: authed(KEY_A) });
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).deleted, true);

  const history = await fetch(`${base}/api/documents/runbook/history`, { headers: authed(KEY_A) });
  assert.equal(history.status, 200);
  const historyBody = await history.json();
  assert.equal(historyBody.revisions, 3);

  // Resurrection continues the chain.
  const resurrected = await fetch(`${base}/api/documents`, {
    method: 'POST',
    headers: authed(KEY_A),
    body: JSON.stringify({ id: 'runbook', title: 'Runbook reborn', body: 'Back again.' })
  });
  assert.equal(resurrected.status, 201);
  assert.equal((await resurrected.json()).version, 4);
});

test('shadow paths: empty body, invalid JSON, invalid fields, oversize body', async () => {
  const empty = await fetch(`${base}/api/documents`, { method: 'POST', headers: authed(KEY_A), body: '' });
  assert.equal(empty.status, 400);

  const invalidJson = await fetch(`${base}/api/documents`, { method: 'POST', headers: authed(KEY_A), body: '{' });
  assert.equal(invalidJson.status, 400);
  assert.equal((await invalidJson.json()).error, 'invalid_json');

  const badFields = await fetch(`${base}/api/documents`, {
    method: 'POST',
    headers: authed(KEY_A),
    body: JSON.stringify({ id: 'BAD ID!', title: 'x', body: 'y' })
  });
  assert.equal(badFields.status, 400);
  assert.equal((await badFields.json()).error, 'invalid_document');

  const big = await fetch(`${base}/api/documents`, {
    method: 'POST',
    headers: authed(KEY_A),
    body: JSON.stringify({ id: 'big', title: 'big', body: 'x'.repeat(300 * 1024) })
  });
  assert.equal(big.status, 413);
});

test('workspace scoping: key B cannot see, edit, or read history of key A documents', async () => {
  await fetch(`${base}/api/documents`, {
    method: 'POST',
    headers: authed(KEY_A),
    body: JSON.stringify({ id: 'private-a', title: 'Private A', body: 'secret content alpha' })
  });

  const searchB = await fetch(`${base}/api/search?q=secret%20content%20alpha`, { headers: authed(KEY_B) });
  const searchBBody = await searchB.json();
  assert.ok(!searchBBody.results.some((r) => r.id === 'private-a'));

  const anonSearch = await fetch(`${base}/api/search?q=secret%20content%20alpha`);
  assert.ok(!(await anonSearch.json()).results.some((r) => r.id === 'private-a'));

  const searchA = await fetch(`${base}/api/search?q=secret%20content%20alpha`, { headers: authed(KEY_A) });
  assert.ok((await searchA.json()).results.some((r) => r.id === 'private-a'));

  const editB = await fetch(`${base}/api/documents/private-a`, {
    method: 'PUT',
    headers: authed(KEY_B),
    body: JSON.stringify({ title: 'Hijacked', expectedVersion: 1 })
  });
  assert.equal(editB.status, 404, 'cross-workspace edit is indistinguishable from missing');

  const historyB = await fetch(`${base}/api/documents/private-a/history`, { headers: authed(KEY_B) });
  assert.equal(historyB.status, 404);
});

test('R1: /api/repository keeps the UI contract (count + items) and paginates', async () => {
  const anon = await fetch(`${base}/api/repository`);
  assert.equal(anon.status, 200);
  const anonBody = await anon.json();
  assert.ok(typeof anonBody.count === 'number' && Array.isArray(anonBody.items), 'public/app.js consumes count+items');
  assert.equal(anonBody.count, seeds.length, 'anonymous sees only the public corpus');

  const page = await fetch(`${base}/api/repository?limit=3&offset=2`);
  const pageBody = await page.json();
  assert.equal(pageBody.items.length, 3);
  assert.equal(pageBody.offset, 2);
  assert.equal(pageBody.count, seeds.length, 'count is the total, not the page size');

  const authedRepo = await fetch(`${base}/api/repository`, { headers: authed(KEY_A) });
  const authedBody = await authedRepo.json();
  assert.ok(authedBody.count > seeds.length, 'a key sees public + its own workspace');
});

// --- D9 idempotent upsert + single-doc GET (design doc server-side-ingestion.md) ---

test('upsert: create → unchanged → updated, with server-owned comparison', async () => {
  const put = (payload) => fetch(`${base}/api/documents/ups-doc?mode=upsert`, {
    method: 'PUT', headers: authed(KEY_A), body: JSON.stringify(payload)
  });

  const created = await put({ title: 'Upsert Doc', body: 'first', tags: ['project:x'] });
  assert.equal(created.status, 201);
  const c = await created.json();
  assert.equal(c.outcome, 'created');
  assert.equal(c.document.version, 1);

  // Identical content (modulo the trim the server applies) writes nothing.
  const same = await put({ title: ' Upsert Doc ', body: 'first\n', tags: ['project:x'] });
  assert.equal(same.status, 200);
  const s = await same.json();
  assert.equal(s.outcome, 'unchanged');
  assert.equal(s.document.version, 1);
  const history = await (await fetch(`${base}/api/documents/ups-doc/history`, { headers: authed(KEY_A) })).json();
  assert.equal(history.revisions, 1, 'unchanged upsert must not grow the append-only history');

  const changed = await put({ title: 'Upsert Doc', body: 'second', tags: ['project:x'] });
  assert.equal(changed.status, 200);
  const u = await changed.json();
  assert.equal(u.outcome, 'updated');
  assert.equal(u.document.version, 2);
});

test('upsert: tags merge additively — never destroys tags added elsewhere', async () => {
  await fetch(`${base}/api/documents/ups-tags?mode=upsert`, {
    method: 'PUT', headers: authed(KEY_A),
    body: JSON.stringify({ title: 'T', body: 'b', tags: ['project:x'] })
  });
  // Another writer adds a tag through the authoritative PUT.
  await fetch(`${base}/api/documents/ups-tags`, {
    method: 'PUT', headers: authed(KEY_A),
    body: JSON.stringify({ tags: ['project:x', 'important'], expectedVersion: 1 })
  });
  // A read-free upsert with only its own tag neither churns nor wipes.
  const same = await (await fetch(`${base}/api/documents/ups-tags?mode=upsert`, {
    method: 'PUT', headers: authed(KEY_A),
    body: JSON.stringify({ title: 'T', body: 'b', tags: ['project:x'] })
  })).json();
  assert.equal(same.outcome, 'unchanged');
  assert.deepEqual(same.document.tags, ['project:x', 'important']);
});

test('upsert: validation and auth mirror the write path', async () => {
  const anon = await fetch(`${base}/api/documents/ups-doc?mode=upsert`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 't', body: 'b' })
  });
  assert.equal(anon.status, 401);

  const mismatch = await fetch(`${base}/api/documents/ups-doc?mode=upsert`, {
    method: 'PUT', headers: authed(KEY_A),
    body: JSON.stringify({ id: 'other-id', title: 't', body: 'b' })
  });
  assert.equal(mismatch.status, 400);
  assert.match((await mismatch.json()).message, /does not match/);
});

test('GET /api/documents/:id returns the current revision with workspace scoping', async () => {
  const doc = await fetch(`${base}/api/documents/ups-doc`, { headers: authed(KEY_A) });
  assert.equal(doc.status, 200);
  const body = await doc.json();
  assert.equal(body.id, 'ups-doc');
  assert.equal(body.version, 2);
  assert.equal(body.body, 'second');

  // Other workspaces (and anonymous callers) cannot see it.
  const cross = await fetch(`${base}/api/documents/ups-doc`, { headers: authed(KEY_B) });
  assert.equal(cross.status, 404);
  const anon = await fetch(`${base}/api/documents/ups-doc`);
  assert.equal(anon.status, 404);

  // Anonymous CAN read a public seed doc by id.
  const seedRes = await fetch(`${base}/api/documents/${seeds[0].id}`);
  assert.equal(seedRes.status, 200);
});

test('upsert: malformed tags are rejected with 400, never iterated into the doc', async () => {
  // Strings are iterable — without up-front validation, tags:"prod" would
  // merge as ['p','r','o','d'] and PASS the normalizer's array check.
  const asString = await fetch(`${base}/api/documents/ups-doc?mode=upsert`, {
    method: 'PUT', headers: authed(KEY_A),
    body: JSON.stringify({ title: 'Upsert Doc', body: 'second', tags: 'prod' })
  });
  assert.equal(asString.status, 400);
  assert.match((await asString.json()).message, /array of strings/);

  // Non-iterables must be a 400 ValidationError, not a raw TypeError → 500.
  const asNumber = await fetch(`${base}/api/documents/ups-doc?mode=upsert`, {
    method: 'PUT', headers: authed(KEY_A),
    body: JSON.stringify({ title: 'Upsert Doc', body: 'second', tags: 5 })
  });
  assert.equal(asNumber.status, 400);
});

test('upsert: a version precondition is rejected loudly, never silently discarded', async () => {
  const viaBody = await fetch(`${base}/api/documents/ups-doc?mode=upsert`, {
    method: 'PUT', headers: authed(KEY_A),
    body: JSON.stringify({ title: 'Upsert Doc', body: 'stale write', expectedVersion: 1 })
  });
  assert.equal(viaBody.status, 400);
  assert.match((await viaBody.json()).message, /incompatible with mode=upsert/);

  const viaHeader = await fetch(`${base}/api/documents/ups-doc?mode=upsert`, {
    method: 'PUT', headers: { ...authed(KEY_A), 'If-Match': '1' },
    body: JSON.stringify({ title: 'Upsert Doc', body: 'stale write' })
  });
  assert.equal(viaHeader.status, 400);

  // Neither attempt wrote anything.
  const doc = await (await fetch(`${base}/api/documents/ups-doc`, { headers: authed(KEY_A) })).json();
  assert.equal(doc.body, 'second');
});

test('upsert resurrects a tombstoned id: version continues, createdAt is fresh and matches the row', async () => {
  await fetch(`${base}/api/documents/rez-doc?mode=upsert`, {
    method: 'PUT', headers: authed(KEY_A),
    body: JSON.stringify({ title: 'Rez', body: 'v1' })
  });
  await fetch(`${base}/api/documents/rez-doc`, { method: 'DELETE', headers: authed(KEY_A) });

  const rez = await fetch(`${base}/api/documents/rez-doc?mode=upsert`, {
    method: 'PUT', headers: authed(KEY_A),
    body: JSON.stringify({ title: 'Rez', body: 'v2 after resurrection' })
  });
  assert.equal(rez.status, 201, 'resurrection is a create');
  const created = await rez.json();
  assert.equal(created.outcome, 'created');
  assert.equal(created.document.version, 3, 'history continues past the tombstone (v1, v2 tombstone, v3)');

  // The stored row must agree with the 201 body (the pg resurrection UPDATE
  // rewrites created_at for exactly this contract).
  const readBack = await (await fetch(`${base}/api/documents/rez-doc`, { headers: authed(KEY_A) })).json();
  assert.equal(readBack.createdAt, created.document.createdAt);
});

test('delete releases live storage bytes: delete+recreate cycles do not inflate the quota', async () => {
  const bigBody = 'x'.repeat(5_000);
  await fetch(`${base}/api/documents/cycle-doc?mode=upsert`, {
    method: 'PUT', headers: authed(KEY_A),
    body: JSON.stringify({ title: 'Cycle', body: bigBody })
  });
  const after1 = store.keys.get('ws-a').storageBytes;
  await fetch(`${base}/api/documents/cycle-doc`, { method: 'DELETE', headers: authed(KEY_A) });
  await fetch(`${base}/api/documents/cycle-doc?mode=upsert`, {
    method: 'PUT', headers: authed(KEY_A),
    body: JSON.stringify({ title: 'Cycle', body: bigBody })
  });
  const after2 = store.keys.get('ws-a').storageBytes;
  assert.ok(Math.abs(after2 - after1) < 500,
    `delete+recreate must be storage-neutral (was ${after1}, now ${after2})`);
});
