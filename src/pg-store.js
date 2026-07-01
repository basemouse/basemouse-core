// Postgres store implementing the same M1 contract as MemoryStore (see
// src/memory-store.js for the contract comment). Connects via DATABASE_URL
// (managed Postgres — Supabase). Every write keeps the append-only revisions
// invariant: document row mutation and revision insert happen in ONE
// transaction, and the keys.doc_count counter moves in that same transaction
// so quota checks (M2) are counter comparisons, never racy COUNT(*).
//
//   write request ──► BEGIN
//                       upsert/update documents row (optimistic version check)
//                       INSERT revisions (full snapshot)
//                       UPDATE keys SET doc_count, storage_bytes
//                     COMMIT ──► response
//
// Connection failures surface as StoreUnavailableError so the server can
// degrade the public demo to the in-memory seed corpus (design decision 1A).

import pg from 'pg';
import { checksum } from './store.js';
import {
  AlreadyClaimedError,
  DuplicateDocumentError,
  DocumentNotFoundError,
  QuotaExceededError,
  StorageQuotaExceededError,
  StoreUnavailableError,
  VersionConflictError
} from './errors.js';
import { PUBLIC_WORKSPACE, OPERATOR_SETTABLE_STATUSES, PROTECTED_KEY_STATUSES } from './memory-store.js';

const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN',
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '08001', '08003', '08006' // connection exceptions
]);

function isConnectionError(error) {
  return Boolean(
    error && (CONNECTION_ERROR_CODES.has(error.code) ||
      /timeout exceeded when trying to connect/i.test(error.message || ''))
  );
}

function rowToDoc(row) {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    tags: row.tags,
    body: row.body,
    links: row.links,
    version: row.version,
    author: row.author,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    checksum: row.checksum,
    source: row.source,
    workspace: row.workspace_id,
    deleted: row.deleted
  };
}

function docByteSize(doc) {
  return Buffer.byteLength(JSON.stringify(doc), 'utf8');
}

// TLS posture: remote databases always get verified TLS. Providers whose
// server certs chain to a private CA (Supabase direct connections do) supply
// that CA as PEM via DATABASE_CA_CERT (k8s Secret) — verification is never
// disabled. Local/CI connections (localhost service container) skip TLS.
function sslConfig(databaseUrl, env = process.env) {
  if (/localhost|127\.0\.0\.1/.test(databaseUrl)) return undefined;
  const ca = env.DATABASE_CA_CERT;
  return ca ? { ca } : true;
}

export class PgStore {
  constructor(databaseUrl, { max = 10, connectionTimeoutMillis = 5000, env = process.env } = {}) {
    this.pool = new pg.Pool({
      connectionString: databaseUrl,
      max,
      connectionTimeoutMillis,
      ssl: sslConfig(databaseUrl, env)
    });
  }

  async close() {
    await this.pool.end();
  }

  async query(text, params) {
    try {
      return await this.pool.query(text, params);
    } catch (error) {
      if (isConnectionError(error)) throw new StoreUnavailableError(error);
      throw error;
    }
  }

  // Run fn(client) inside one transaction; map connection failures.
  async tx(fn) {
    let client;
    try {
      client = await this.pool.connect();
    } catch (error) {
      if (isConnectionError(error)) throw new StoreUnavailableError(error);
      throw error;
    }
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (isConnectionError(error)) throw new StoreUnavailableError(error);
      throw error;
    } finally {
      client.release();
    }
  }

  async ping() {
    await this.query('SELECT 1');
    return true;
  }

  async ensureSeeds(docs) {
    // Idempotent insert-if-missing keyed by document id; the Postgres copy is
    // never overwritten by later repo seed edits (drift accepted by design).
    await this.tx(async (client) => {
      for (const doc of docs) {
        const inserted = await client.query(
          `INSERT INTO documents (workspace_id, id, title, type, tags, body, links,
                                  version, author, created_at, updated_at, checksum, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (workspace_id, id) DO NOTHING`,
          [PUBLIC_WORKSPACE, doc.id, doc.title, doc.type, JSON.stringify(doc.tags), doc.body,
            JSON.stringify(doc.links), doc.version, doc.author, doc.createdAt, doc.updatedAt,
            doc.checksum, JSON.stringify(doc.source)]
        );
        if (inserted.rowCount > 0) {
          await client.query(
            `INSERT INTO revisions (workspace_id, document_id, version, snapshot)
             VALUES ($1,$2,$3,$4)`,
            [PUBLIC_WORKSPACE, doc.id, doc.version, JSON.stringify({ ...doc, workspace: PUBLIC_WORKSPACE, deleted: false })]
          );
        }
      }
    });
  }

  async listVisible(workspaceIds) {
    const result = await this.query(
      `SELECT * FROM documents
       WHERE workspace_id = ANY($1) AND NOT deleted
       ORDER BY updated_at DESC NULLS LAST, id ASC`,
      [workspaceIds]
    );
    return result.rows.map(rowToDoc);
  }

  async getDocument(workspaceIds, id) {
    const result = await this.query(
      `SELECT * FROM documents
       WHERE workspace_id = ANY($1) AND id = $2 AND NOT deleted
       ORDER BY (workspace_id = 'public') ASC
       LIMIT 1`,
      [workspaceIds, id]
    );
    return result.rows[0] ? rowToDoc(result.rows[0]) : null;
  }

  async createDocument(workspaceId, doc, limits = null) {
    return this.tx(async (client) => {
      // Quota check inside the same transaction as the write: the keys row
      // lock serializes concurrent creates, so the counter comparison is
      // exact under any concurrency (design: quota-boundary race test).
      if (limits) {
        const key = await client.query(
          'SELECT doc_count, storage_bytes FROM keys WHERE id=$1 FOR UPDATE',
          [workspaceId]
        );
        const row = key.rows[0];
        const byteSize = docByteSize(doc);
        if (row && row.doc_count >= limits.maxDocuments) {
          throw new QuotaExceededError('document', { documents: row.doc_count, maxDocuments: limits.maxDocuments });
        }
        if (row && Number(row.storage_bytes) + byteSize > limits.maxStorageBytes) {
          throw new StorageQuotaExceededError({ storageBytes: Number(row.storage_bytes), maxStorageBytes: limits.maxStorageBytes });
        }
      }
      const existing = await client.query(
        'SELECT version, deleted FROM documents WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [workspaceId, doc.id]
      );
      let record = { ...doc, workspace: workspaceId, deleted: false };
      if (existing.rows[0]) {
        if (!existing.rows[0].deleted) throw new DuplicateDocumentError(doc.id);
        // Tombstone resurrection: version continues monotonically.
        record.version = existing.rows[0].version + 1;
        record.checksum = checksum(record);
        await client.query(
          `UPDATE documents SET title=$3, type=$4, tags=$5, body=$6, links=$7,
             version=$8, author=$9, updated_at=$10, checksum=$11, source=$12, deleted=false
           WHERE workspace_id=$1 AND id=$2`,
          [workspaceId, doc.id, record.title, record.type, JSON.stringify(record.tags),
            record.body, JSON.stringify(record.links), record.version, record.author,
            record.updatedAt, record.checksum, JSON.stringify(record.source)]
        );
      } else {
        await client.query(
          `INSERT INTO documents (workspace_id, id, title, type, tags, body, links,
                                  version, author, created_at, updated_at, checksum, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [workspaceId, doc.id, record.title, record.type, JSON.stringify(record.tags),
            record.body, JSON.stringify(record.links), record.version, record.author,
            record.createdAt, record.updatedAt, record.checksum, JSON.stringify(record.source)]
        );
      }
      await client.query(
        `INSERT INTO revisions (workspace_id, document_id, version, snapshot) VALUES ($1,$2,$3,$4)`,
        [workspaceId, doc.id, record.version, JSON.stringify(record)]
      );
      await client.query(
        'UPDATE keys SET doc_count = doc_count + 1, storage_bytes = storage_bytes + $2 WHERE id = $1',
        [workspaceId, docByteSize(record)]
      );
      return record;
    });
  }

  async updateDocument(workspaceId, id, fields, expectedVersion) {
    return this.tx(async (client) => {
      const existing = await client.query(
        'SELECT * FROM documents WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [workspaceId, id]
      );
      const row = existing.rows[0];
      if (!row || row.deleted) throw new DocumentNotFoundError(id);
      if (row.version !== expectedVersion) throw new VersionConflictError(row.version);

      const updated = {
        ...rowToDoc(row),
        ...fields,
        id,
        workspace: workspaceId,
        version: row.version + 1,
        updatedAt: new Date().toISOString(),
        deleted: false
      };
      updated.checksum = checksum(updated);
      await client.query(
        `UPDATE documents SET title=$3, type=$4, tags=$5, body=$6, links=$7,
           version=$8, author=$9, updated_at=$10, checksum=$11
         WHERE workspace_id=$1 AND id=$2`,
        [workspaceId, id, updated.title, updated.type, JSON.stringify(updated.tags),
          updated.body, JSON.stringify(updated.links), updated.version, updated.author,
          updated.updatedAt, updated.checksum]
      );
      await client.query(
        `INSERT INTO revisions (workspace_id, document_id, version, snapshot) VALUES ($1,$2,$3,$4)`,
        [workspaceId, id, updated.version, JSON.stringify(updated)]
      );
      await client.query(
        'UPDATE keys SET storage_bytes = storage_bytes + $2 WHERE id = $1',
        [workspaceId, docByteSize(updated)]
      );
      return updated;
    });
  }

  async deleteDocument(workspaceId, id) {
    return this.tx(async (client) => {
      const existing = await client.query(
        'SELECT * FROM documents WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [workspaceId, id]
      );
      const row = existing.rows[0];
      if (!row || row.deleted) throw new DocumentNotFoundError(id);

      const version = row.version + 1;
      const updatedAt = new Date().toISOString();
      await client.query(
        'UPDATE documents SET deleted=true, version=$3, updated_at=$4 WHERE workspace_id=$1 AND id=$2',
        [workspaceId, id, version, updatedAt]
      );
      const tombstone = { ...rowToDoc(row), version, updatedAt, deleted: true };
      await client.query(
        `INSERT INTO revisions (workspace_id, document_id, version, snapshot) VALUES ($1,$2,$3,$4)`,
        [workspaceId, id, version, JSON.stringify(tombstone)]
      );
      // Tombstones free document quota immediately (storage stays — history is kept).
      await client.query(
        'UPDATE keys SET doc_count = doc_count - 1 WHERE id = $1',
        [workspaceId]
      );
      return { id, version, deleted: true };
    });
  }

  async getHistory(workspaceIds, id) {
    const result = await this.query(
      `SELECT workspace_id, version, snapshot, created_at FROM revisions
       WHERE workspace_id = ANY($1) AND document_id = $2
       ORDER BY workspace_id, version ASC`,
      [workspaceIds, id]
    );
    if (result.rows.length === 0) return null;
    // First visible workspace that has history wins (workspace before public).
    const byWorkspace = new Map();
    for (const row of result.rows) {
      if (!byWorkspace.has(row.workspace_id)) byWorkspace.set(row.workspace_id, []);
      byWorkspace.get(row.workspace_id).push({
        version: row.version,
        snapshot: row.snapshot,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
      });
    }
    for (const wsId of workspaceIds) {
      if (byWorkspace.has(wsId)) return byWorkspace.get(wsId);
    }
    return null;
  }

  async findKeyByHash(keyHash) {
    const result = await this.query('SELECT * FROM keys WHERE key_hash = $1', [keyHash]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      plan: row.plan,
      status: row.status,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      cancelledAt: row.cancelled_at,
      docCount: row.doc_count,
      storageBytes: Number(row.storage_bytes)
    };
  }

  // --- M2 domains: usage counters, Stripe lifecycle -------------------------

  async recordPackPull(keyId, month, limit) {
    return this.tx(async (client) => {
      await client.query(
        'INSERT INTO usage (key_id, month, pack_pulls) VALUES ($1, $2, 0) ON CONFLICT (key_id, month) DO NOTHING',
        [keyId, month]
      );
      const updated = await client.query(
        'UPDATE usage SET pack_pulls = pack_pulls + 1 WHERE key_id=$1 AND month=$2 AND pack_pulls < $3 RETURNING pack_pulls',
        [keyId, month, limit]
      );
      if (updated.rowCount === 0) {
        const current = await client.query('SELECT pack_pulls FROM usage WHERE key_id=$1 AND month=$2', [keyId, month]);
        throw new QuotaExceededError('pack pulls', {
          packPulls: current.rows[0]?.pack_pulls ?? limit,
          packPullsPerMonth: limit
        });
      }
      return { packPulls: updated.rows[0].pack_pulls };
    });
  }

  async getUsage(keyId, month) {
    const result = await this.query(
      `SELECT k.plan, k.status, k.doc_count, k.storage_bytes,
              COALESCE(u.pack_pulls, 0) AS pack_pulls
       FROM keys k LEFT JOIN usage u ON u.key_id = k.id AND u.month = $2
       WHERE k.id = $1`,
      [keyId, month]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      plan: row.plan,
      status: row.status,
      docCount: row.doc_count,
      storageBytes: Number(row.storage_bytes),
      packPulls: row.pack_pulls,
      month
    };
  }

  // Cumulative usage across ALL months for a key — getUsage is current-month
  // only, so a validation window spanning a month boundary needs this. Null
  // for an unknown key id.
  async getCumulativeUsage(keyId) {
    const keyRow = await this.query(
      'SELECT plan, status, doc_count, storage_bytes FROM keys WHERE id = $1',
      [keyId]
    );
    if (keyRow.rows.length === 0) return null;
    const k = keyRow.rows[0];
    const usageRows = await this.query(
      'SELECT month, pack_pulls FROM usage WHERE key_id = $1 ORDER BY month',
      [keyId]
    );
    const months = usageRows.rows.map((r) => ({ month: r.month, packPulls: r.pack_pulls }));
    return {
      keyId,
      plan: k.plan,
      status: k.status,
      docCount: k.doc_count,
      storageBytes: Number(k.storage_bytes),
      totalPackPulls: months.reduce((sum, m) => sum + m.packPulls, 0),
      months
    };
  }

  // Returns true when the event is new; false when already processed.
  async markStripeEvent(eventId, created) {
    const result = await this.query(
      'INSERT INTO stripe_events (event_id, created) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING',
      [eventId, created]
    );
    return result.rowCount > 0;
  }

  keyRowToObject(row) {
    return {
      id: row.id,
      plan: row.plan,
      status: row.status,
      stripeCustomerId: row.stripe_customer_id,
      stripeSubscriptionId: row.stripe_subscription_id,
      cancelledAt: row.cancelled_at,
      lastEventCreated: row.last_event_created == null ? null : Number(row.last_event_created),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      docCount: row.doc_count,
      storageBytes: Number(row.storage_bytes)
    };
  }

  async getKeyById(keyId) {
    const result = await this.query('SELECT * FROM keys WHERE id = $1', [keyId]);
    return result.rows[0] ? this.keyRowToObject(result.rows[0]) : null;
  }

  async findKeyByCustomer(stripeCustomerId) {
    const result = await this.query('SELECT * FROM keys WHERE stripe_customer_id = $1', [stripeCustomerId]);
    return result.rows[0] ? this.keyRowToObject(result.rows[0]) : null;
  }

  // Idempotent: whichever of webhook/claim lands first creates the record;
  // the unique stripe_customer_id index resolves the race.
  async upsertPendingKey({ customerId, subscriptionId, plan, eventCreated }) {
    return this.tx(async (client) => {
      await client.query(
        `INSERT INTO keys (plan, status, stripe_customer_id, stripe_subscription_id, last_event_created)
         VALUES ($1, 'pending_claim', $2, $3, $4)
         ON CONFLICT (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL DO NOTHING`,
        [plan, customerId, subscriptionId || null, eventCreated ?? null]
      );
      const row = await client.query('SELECT * FROM keys WHERE stripe_customer_id = $1', [customerId]);
      return this.keyRowToObject(row.rows[0]);
    });
  }

  async activateKey(keyId, keyHash, actor = 'claim') {
    return this.tx(async (client) => {
      const updated = await client.query(
        `UPDATE keys SET key_hash = $2, status = 'active'
         WHERE id = $1 AND status = 'pending_claim' RETURNING *`,
        [keyId, keyHash]
      );
      if (updated.rowCount === 0) throw new AlreadyClaimedError();
      await client.query('INSERT INTO key_audit (key_id, action, actor) VALUES ($1, $2, $3)', [keyId, 'claimed', actor]);
      return this.keyRowToObject(updated.rows[0]);
    });
  }

  // Out-of-order Stripe events resolve by event `created` (OV-E1.3): the
  // WHERE clause drops stale events atomically.
  async updateSubscriptionState(customerId, { plan, status, cancelledAt, eventCreated }) {
    return this.tx(async (client) => {
      const updated = await client.query(
        `UPDATE keys SET
           plan = COALESCE($2, plan),
           status = COALESCE($3, status),
           cancelled_at = CASE WHEN $4::timestamptz IS NOT NULL THEN $4::timestamptz
                               WHEN $3 = 'active' THEN NULL
                               ELSE cancelled_at END,
           last_event_created = $5
         WHERE stripe_customer_id = $1
           AND (last_event_created IS NULL OR last_event_created < $5)
         RETURNING *`,
        [customerId, plan || null, status || null, cancelledAt || null, eventCreated]
      );
      if (updated.rowCount === 0) {
        const existing = await client.query('SELECT * FROM keys WHERE stripe_customer_id = $1', [customerId]);
        return existing.rows[0] ? this.keyRowToObject(existing.rows[0]) : null;
      }
      await client.query(
        'INSERT INTO key_audit (key_id, action, actor) VALUES ($1, $2, $3)',
        [updated.rows[0].id, `subscription_${status || 'updated'}`, 'stripe-webhook']
      );
      return this.keyRowToObject(updated.rows[0]);
    });
  }

  async rotateKeyHash(keyId, newHash, actor = 'rotate') {
    return this.tx(async (client) => {
      const updated = await client.query(
        'UPDATE keys SET key_hash = $2, rotated_at = now() WHERE id = $1 RETURNING *',
        [keyId, newHash]
      );
      if (updated.rowCount === 0) return null;
      await client.query('INSERT INTO key_audit (key_id, action, actor) VALUES ($1, $2, $3)', [keyId, 'rotated', actor]);
      return this.keyRowToObject(updated.rows[0]);
    });
  }

  // Operator off-switch: revoke / read_only (freeze) / active (reactivate).
  // Never touches a 'system' key. Returns null when the id is unknown.
  async setKeyStatus(keyId, status, actor = 'admin-script') {
    if (!OPERATOR_SETTABLE_STATUSES.has(status)) {
      throw new Error(`invalid status "${status}" (expected: ${[...OPERATOR_SETTABLE_STATUSES].join(', ')})`);
    }
    // Never overwrite a protected status (system / pending_claim) — build the
    // NOT IN list from the shared set so it can't drift from MemoryStore.
    const protectedList = [...PROTECTED_KEY_STATUSES];
    const placeholders = protectedList.map((_, i) => `$${i + 3}`).join(', ');
    return this.tx(async (client) => {
      const updated = await client.query(
        `UPDATE keys SET status = $2 WHERE id = $1 AND status NOT IN (${placeholders}) RETURNING *`,
        [keyId, status, ...protectedList]
      );
      if (updated.rowCount === 0) return null;
      await client.query('INSERT INTO key_audit (key_id, action, actor) VALUES ($1, $2, $3)', [keyId, `status_${status}`, actor]);
      return this.keyRowToObject(updated.rows[0]);
    });
  }

  async createKey({ id, plan = 'demo', keyHash, actor = 'system' }) {
    return this.tx(async (client) => {
      const result = await client.query(
        `INSERT INTO keys (id, plan, status, key_hash)
         VALUES (COALESCE($1, gen_random_uuid()::text), $2, 'active', $3)
         RETURNING id, plan, status, created_at`,
        [id || null, plan, keyHash || null]
      );
      const key = result.rows[0];
      await client.query(
        'INSERT INTO key_audit (key_id, action, actor) VALUES ($1, $2, $3)',
        [key.id, 'issued', actor]
      );
      return {
        id: key.id,
        plan: key.plan,
        status: key.status,
        createdAt: key.created_at.toISOString(),
        docCount: 0,
        storageBytes: 0
      };
    });
  }
}
