// Store contract suite: the SAME tests run against MemoryStore (always) and
// PgStore (when TEST_DATABASE_URL is set — CI provides a postgres service
// container via `npm run test:pg`). This is what keeps the two
// implementations from drifting (design doc: "PgStore is NOT allowed to
// ship untested").
//
// Includes regression R2: search over the seed corpus must produce
// byte-identical results through the store path as through the legacy
// in-memory array path.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryStore, PUBLIC_WORKSPACE } from '../src/memory-store.js';
import { createSeedRepository } from '../src/store.js';
import { searchRepository } from '../src/basemouse-core.js';
import { hashKey } from '../src/auth.js';

const seeds = createSeedRepository();

const backends = [
  {
    name: 'MemoryStore',
    create: async () => new MemoryStore(seeds),
    destroy: async () => {}
  }
];

if (process.env.TEST_DATABASE_URL) {
  const { PgStore } = await import('../src/pg-store.js');
  backends.push({
    name: 'PgStore',
    create: async () => {
      const store = new PgStore(process.env.TEST_DATABASE_URL, { max: 4 });
      // Fresh schema per run: integration databases are throwaway. Apply the
      // FULL migrations directory, exactly like scripts/migrate.mjs does —
      // a migration the contract suite doesn't apply is a table the suite
      // can't test.
      await store.query('DROP TABLE IF EXISTS usage, stripe_events, revisions, documents, key_audit, keys CASCADE');
      const { readFile, readdir } = await import('node:fs/promises');
      const dir = new URL('../migrations/', import.meta.url);
      const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
      for (const file of files) {
        await store.query(await readFile(new URL(file, dir), 'utf8'));
      }
      await store.ensureSeeds(seeds);
      return store;
    },
    destroy: async (store) => store.close()
  });
} else {
  test('PgStore contract suite (skipped — TEST_DATABASE_URL not set)', { skip: true }, () => {});
}

const doc = (id, overrides = {}) => ({
  id,
  title: `Title ${id}`,
  type: 'note',
  tags: ['contract'],
  body: `Body for ${id}`,
  links: [],
  version: 1,
  author: 'contract-test',
  createdAt: '2026-06-11T00:00:00.000Z',
  updatedAt: '2026-06-11T00:00:00.000Z',
  checksum: 'recomputed-on-write',
  source: { kind: 'api', workspace: 'ws-contract' },
  ...overrides
});

for (const backend of backends) {
  test(`[${backend.name}] full contract`, async (t) => {
    const store = await backend.create();
    const ws = 'ws-contract';
    await store.createKey({ id: ws, plan: 'demo', keyHash: hashKey('bm_' + 'a'.repeat(48)) });

    await t.test('ping resolves', async () => {
      assert.equal(await store.ping(), true);
    });

    await t.test('seeds are visible in the public workspace', async () => {
      const docs = await store.listVisible([PUBLIC_WORKSPACE]);
      assert.equal(docs.length, seeds.length);
    });

    await t.test('R2: search parity with the legacy in-memory path', async () => {
      const viaStore = searchRepository(await store.listVisible([PUBLIC_WORKSPACE]), 'agent context');
      const viaArray = searchRepository(seeds, 'agent context');
      assert.deepEqual(
        viaStore.map((r) => ({ id: r.id, score: r.relevance?.score ?? r.score })),
        viaArray.map((r) => ({ id: r.id, score: r.relevance?.score ?? r.score }))
      );
    });

    await t.test('create / get / workspace scoping', async () => {
      const created = await store.createDocument(ws, doc('alpha'));
      assert.equal(created.version, 1);
      assert.ok(created.checksum);

      assert.ok(await store.getDocument([ws], 'alpha'));
      assert.equal(await store.getDocument([PUBLIC_WORKSPACE], 'alpha'), null, 'private docs never leak to public');
      const visible = await store.listVisible([ws, PUBLIC_WORKSPACE]);
      assert.equal(visible.length, seeds.length + 1);
    });

    await t.test('duplicate id rejected', async () => {
      await assert.rejects(store.createDocument(ws, doc('alpha')), /already exists/);
    });

    await t.test('optimistic locking: stale version conflicts', async () => {
      const updated = await store.updateDocument(ws, 'alpha', { title: 'Updated alpha' }, 1);
      assert.equal(updated.version, 2);
      await assert.rejects(
        store.updateDocument(ws, 'alpha', { title: 'Stale write' }, 1),
        /expectedVersion does not match/
      );
    });

    await t.test('update of missing document is not_found', async () => {
      await assert.rejects(store.updateDocument(ws, 'ghost', { title: 'x' }, 1), /no document/);
    });

    await t.test('tombstone delete hides the doc but preserves history', async () => {
      const tombstone = await store.deleteDocument(ws, 'alpha');
      assert.equal(tombstone.deleted, true);
      assert.equal(tombstone.version, 3);
      assert.equal(await store.getDocument([ws], 'alpha'), null);

      const history = await store.getHistory([ws], 'alpha');
      assert.equal(history.length, 3);
      assert.equal(history[0].version, 1);
      assert.equal(history[2].snapshot.deleted, true);
    });

    await t.test('double delete is not_found', async () => {
      await assert.rejects(store.deleteDocument(ws, 'alpha'), /no document/);
    });

    await t.test('resurrection: POST of a tombstoned id continues the history chain', async () => {
      const resurrected = await store.createDocument(ws, doc('alpha', { title: 'Alpha lives' }));
      assert.equal(resurrected.version, 4, 'version continues monotonically');
      assert.equal(resurrected.deleted, false);
      const history = await store.getHistory([ws], 'alpha');
      assert.equal(history.length, 4);
    });

    await t.test('key lookup by hash; unknown hash is null', async () => {
      const key = await store.findKeyByHash(hashKey('bm_' + 'a'.repeat(48)));
      assert.equal(key.id, ws);
      assert.equal(await store.findKeyByHash(hashKey('bm_' + 'f'.repeat(48))), null);
    });

    await t.test('M2: pack-pull quota is exact at the boundary', async () => {
      const month = '2026-06';
      await store.recordPackPull(ws, month, 3);
      await store.recordPackPull(ws, month, 3);
      const third = await store.recordPackPull(ws, month, 3);
      assert.equal(third.packPulls, 3);
      await assert.rejects(store.recordPackPull(ws, month, 3), /pack pulls/);
      const usage = await store.getUsage(ws, month);
      assert.equal(usage.packPulls, 3, 'a denied pull never increments the counter');
    });

    await t.test('M2: document quota enforced transactionally', async () => {
      // Dedicated workspace: quota counters are lifetime, so the shared
      // contract workspace already has documents counted against it.
      const qws = 'ws-quota-contract';
      await store.createKey({ id: qws, plan: 'demo', keyHash: hashKey('bm_' + 'e'.repeat(48)) });
      const tinyLimits = { maxDocuments: 1, maxStorageBytes: 1024 * 1024 };
      await store.createDocument(qws, doc('quota-1'), tinyLimits);
      await assert.rejects(store.createDocument(qws, doc('quota-2'), tinyLimits), /document quota/);
      // Tombstoning frees document quota immediately.
      await store.deleteDocument(qws, 'quota-1');
      await store.createDocument(qws, doc('quota-2'), tinyLimits);
    });

    await t.test('M2: storage allowance blocks oversize, never deletes history', async () => {
      const tinyStorage = { maxDocuments: 100, maxStorageBytes: 10 };
      await assert.rejects(store.createDocument('ws-quota-contract', doc('too-big'), tinyStorage), /storage allowance/);
    });

    await t.test('M2: storage allowance is delta-accounted on update, never the full new size', async () => {
      const uws = 'ws-update-quota-contract';
      await store.createKey({ id: uws, plan: 'demo', keyHash: hashKey('bm_' + '3'.repeat(48)) });
      const created = await store.createDocument(uws, doc('update-quota', { body: 'x'.repeat(50) }));
      const baseline = (await store.getUsage(uws, '2026-06')).storageBytes;

      // Cap set just above current usage: a shrink must still succeed even
      // though there is almost no headroom, and a large growth must be
      // blocked — proving storage is tracked as a delta, not the new total.
      const limits = { maxDocuments: 100, maxStorageBytes: baseline + 10 };

      const shrunk = await store.updateDocument(uws, 'update-quota', { body: 'y' }, created.version, limits);
      assert.equal(shrunk.version, 2);
      const afterShrink = (await store.getUsage(uws, '2026-06')).storageBytes;
      assert.ok(afterShrink < baseline, 'a shrinking edit must free storage, not add the full new document size');

      await assert.rejects(
        store.updateDocument(uws, 'update-quota', { body: 'z'.repeat(500) }, shrunk.version, limits),
        /storage allowance/
      );
      const untouched = await store.getDocument([uws], 'update-quota');
      assert.equal(untouched.version, 2, 'a rejected oversize update must never apply');
      assert.equal((await store.getUsage(uws, '2026-06')).storageBytes, afterShrink, 'a rejected update must not move the counter');
    });

    await t.test('M2: stripe event idempotency', async () => {
      assert.equal(await store.markStripeEvent('evt_contract_1', 100), true);
      assert.equal(await store.markStripeEvent('evt_contract_1', 100), false, 'duplicate is a no-op');
    });

    await t.test('M2: pending key lifecycle — upsert is idempotent, claim activates once', async () => {
      const a = await store.upsertPendingKey({ customerId: 'cus_test1', subscriptionId: 'sub_1', plan: 'starter', eventCreated: 100 });
      const b = await store.upsertPendingKey({ customerId: 'cus_test1', subscriptionId: 'sub_1', plan: 'starter', eventCreated: 101 });
      assert.equal(a.id, b.id, 'webhook and claim upserts converge on one record');
      assert.equal(a.status, 'pending_claim');

      const activated = await store.activateKey(a.id, hashKey('bm_' + 'b'.repeat(48)), 'test');
      assert.equal(activated.status, 'active');
      await assert.rejects(store.activateKey(a.id, hashKey('bm_' + 'c'.repeat(48)), 'test'), /already issued/);
    });

    await t.test('M2: out-of-order subscription events resolve by created timestamp', async () => {
      // Newer event lands first (created=200, cancel)...
      await store.updateSubscriptionState('cus_test1', { status: 'read_only', cancelledAt: '2026-06-11T00:00:00.000Z', eventCreated: 200 });
      // ...then a stale earlier event (created=150) tries to flip it back.
      const after = await store.updateSubscriptionState('cus_test1', { status: 'active', eventCreated: 150 });
      assert.equal(after.status, 'read_only', 'stale events are dropped');
      const fresh = await store.updateSubscriptionState('cus_test1', { plan: 'team', status: 'active', cancelledAt: null, eventCreated: 300 });
      assert.equal(fresh.status, 'active');
      assert.equal(fresh.plan, 'team');
    });

    await t.test('M2: rotation swaps the hash atomically', async () => {
      const oldHash = hashKey('bm_' + 'a'.repeat(48));
      const newHash = hashKey('bm_' + 'd'.repeat(48));
      await store.rotateKeyHash(ws, newHash, 'test');
      assert.equal(await store.findKeyByHash(oldHash), null, 'old key dies immediately');
      const found = await store.findKeyByHash(newHash);
      assert.equal(found.id, ws);
    });

    await t.test('operator setKeyStatus: freeze (read_only), revoke, reactivate', async () => {
      // Dedicated workspace so status flips don't disturb the shared key.
      const sws = 'ws-status-contract';
      await store.createKey({ id: sws, plan: 'starter', keyHash: hashKey('bm_' + '9'.repeat(48)) });

      const frozen = await store.setKeyStatus(sws, 'read_only', 'test');
      assert.equal(frozen.status, 'read_only');
      assert.equal((await store.getKeyById(sws)).status, 'read_only');

      const revoked = await store.setKeyStatus(sws, 'revoked', 'test');
      assert.equal(revoked.status, 'revoked');
      assert.equal((await store.getKeyById(sws)).status, 'revoked');

      const reactivated = await store.setKeyStatus(sws, 'active', 'test');
      assert.equal(reactivated.status, 'active');

      assert.equal(await store.setKeyStatus('ws-ghost', 'revoked', 'test'), null, 'unknown key id is null');
      await assert.rejects(store.setKeyStatus(sws, 'bogus', 'test'), /invalid status/, 'rejects statuses outside the operator set');
    });

    await t.test('setKeyStatus refuses protected statuses (system, pending_claim)', async () => {
      // The system (public-corpus) key and unclaimed Stripe keys are owned by
      // boot/seed and the claim flow — the operator off-switch must not touch
      // them, or it would brick public reads / a paid customer's claim.
      assert.equal(await store.setKeyStatus(PUBLIC_WORKSPACE, 'revoked', 'test'), null, 'system key is untouchable');

      const pending = await store.upsertPendingKey({ customerId: 'cus_guard', subscriptionId: 'sub_g', plan: 'starter', eventCreated: 500 });
      assert.equal(pending.status, 'pending_claim');
      assert.equal(await store.setKeyStatus(pending.id, 'active', 'test'), null, 'pending_claim key is untouchable');
      assert.equal((await store.getKeyById(pending.id)).status, 'pending_claim', 'pending_claim key is unchanged');
    });

    await t.test('getCumulativeUsage sums pack pulls across month boundaries', async () => {
      const cws = 'ws-cumusage';
      await store.createKey({ id: cws, plan: 'starter', keyHash: hashKey('bm_' + '7'.repeat(48)) });
      await store.recordPackPull(cws, '2026-06', 100);
      await store.recordPackPull(cws, '2026-06', 100);
      await store.recordPackPull(cws, '2026-07', 100); // crosses the month boundary

      const cum = await store.getCumulativeUsage(cws);
      assert.equal(cum.totalPackPulls, 3, 'sums every month, not just the current one');
      assert.equal(cum.months.length, 2, 'one entry per month with activity');
      assert.equal(cum.plan, 'starter');
      assert.equal(cum.status, 'active');
      assert.equal(await store.getCumulativeUsage('ws-ghost'), null, 'unknown key id is null');
    });

    await t.test('ensureSeeds is idempotent (drift accepted, never overwrites)', async () => {
      const mutated = seeds.map((s) => ({ ...s, title: 'DRIFTED ' + s.title }));
      await store.ensureSeeds(mutated);
      const docs = await store.listVisible([PUBLIC_WORKSPACE]);
      assert.equal(docs.length, seeds.length);
      assert.ok(!docs.some((d) => d.title.startsWith('DRIFTED')), 'existing seeds are not overwritten');
    });

    await backend.destroy(store);
  });
}
