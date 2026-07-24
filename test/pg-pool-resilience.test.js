// Regression: a Supabase pooler that drops an IDLE backend (idle eviction,
// provider maintenance, an incident) makes node-postgres emit 'error' on the
// Pool itself — not from any query() call. Without a listener that is an
// unhandled EventEmitter 'error' and the process exits 1 (observed in
// production as an exit-code-1 pod restart during a Supabase incident).
//
// Pool construction is lazy — no socket opens until the first query/connect —
// so these assertions run without a database.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PgStore } from '../src/pg-store.js';

// localhost URL keeps sslConfig() from requiring a CA; nothing connects.
const DUMMY_URL = 'postgresql://u:p@localhost:5432/db';

test('PgStore attaches a Pool error handler so an idle-client error never crashes', async () => {
  const store = new PgStore(DUMMY_URL);
  try {
    assert.ok(
      store.pool.listenerCount('error') >= 1,
      'Pool must have an error listener (unhandled pool errors exit the process)'
    );
    // With the listener present, an idle-client error must NOT throw.
    assert.doesNotThrow(() => {
      store.pool.emit('error', Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' }));
    });
  } finally {
    await store.close();
  }
});

test('PgStore enables TCP keepAlive so idle sockets survive the pooler/NAT', async () => {
  const store = new PgStore(DUMMY_URL);
  try {
    // White-box: pg exposes the constructor config on pool.options. Guarded with
    // optional chaining so a future pg internals change fails with this message
    // rather than an opaque TypeError.
    assert.equal(store.pool.options?.keepAlive, true, 'expected keepAlive:true to be passed to pg.Pool');
  } finally {
    await store.close();
  }
});
