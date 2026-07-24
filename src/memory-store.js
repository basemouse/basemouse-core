// In-memory store implementing the M1 store contract (documents, revisions,
// keys). This is the dev/test store AND the degraded-mode fallback corpus for
// the public demo. PgStore implements the identical contract against
// Postgres; test/store-contract.test.js runs the same suite against both so
// the two can never drift.
//
// Contract (M1 domains — quota and webhook domains land with M2/M4):
//   ping()                                  -> resolves when the store is usable
//   listVisible(workspaceIds)               -> non-deleted docs, sorted updatedAt desc then id
//   getDocument(workspaceIds, id)           -> doc | null (first visible match wins, public last)
//   createDocument(workspaceId, doc)        -> created doc (resurrects tombstones)
//   updateDocument(workspaceId, id, fields, expectedVersion) -> updated doc
//   deleteDocument(workspaceId, id)         -> tombstone revision summary
//   getHistory(workspaceIds, id)            -> [{version, snapshot, createdAt}]
//   findKeyByHash(keyHash)                  -> key | null
//   createKey({id?, plan, keyHash, actor})  -> key (audited)
//   ensureSeeds(docs)                       -> idempotent import into 'public'

import { checksum } from './store.js';
import {
  AlreadyClaimedError,
  DuplicateDocumentError,
  DocumentNotFoundError,
  QuotaExceededError,
  StorageQuotaExceededError,
  VersionConflictError
} from './errors.js';

export const PUBLIC_WORKSPACE = 'public';

// Statuses an operator may set on a key via setKeyStatus (issue-key.mjs
// --revoke / --read-only, and reactivation). Lifecycle-internal statuses
// ('system', 'pending_claim') are deliberately excluded — they are owned by
// boot/seed and the Stripe claim flow, not the admin off-switch.
export const OPERATOR_SETTABLE_STATUSES = new Set(['active', 'read_only', 'revoked']);

// Statuses the operator off-switch must NEVER overwrite: the system
// (public-corpus) key is owned by boot/seed, and pending_claim is owned by the
// Stripe claim flow — flipping it would brick a paid customer's claim.
export const PROTECTED_KEY_STATUSES = new Set(['system', 'pending_claim']);

function sortDocs(docs) {
  return docs.sort(
    (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.id.localeCompare(b.id)
  );
}

export class MemoryStore {
  constructor(seedDocs = []) {
    // documents: Map<workspaceId, Map<id, doc>> — doc carries `deleted` flag.
    this.documents = new Map();
    // revisions: Map<`${ws}/${id}`, [{version, snapshot, createdAt}]>
    this.revisions = new Map();
    // keys: Map<keyId, key>, hash index Map<keyHash, keyId>
    this.keys = new Map();
    this.keyHashes = new Map();
    this.keys.set(PUBLIC_WORKSPACE, {
      id: PUBLIC_WORKSPACE,
      plan: 'system',
      status: 'system',
      docCount: 0,
      storageBytes: 0
    });
    this.ensureSeedsSync(seedDocs);
  }

  async ping() {
    return true;
  }

  workspace(workspaceId) {
    if (!this.documents.has(workspaceId)) this.documents.set(workspaceId, new Map());
    return this.documents.get(workspaceId);
  }

  revisionLog(workspaceId, id) {
    const key = `${workspaceId}/${id}`;
    if (!this.revisions.has(key)) this.revisions.set(key, []);
    return this.revisions.get(key);
  }

  appendRevision(workspaceId, doc) {
    this.revisionLog(workspaceId, doc.id).push({
      version: doc.version,
      snapshot: structuredClone(doc),
      createdAt: new Date().toISOString()
    });
  }

  ensureSeedsSync(docs) {
    const ws = this.workspace(PUBLIC_WORKSPACE);
    for (const doc of docs) {
      if (ws.has(doc.id)) continue; // insert-if-missing: repo drift is accepted
      const copy = { ...structuredClone(doc), workspace: PUBLIC_WORKSPACE, deleted: false };
      ws.set(doc.id, copy);
      this.appendRevision(PUBLIC_WORKSPACE, copy);
    }
  }

  async ensureSeeds(docs) {
    this.ensureSeedsSync(docs);
  }

  async listVisible(workspaceIds) {
    const out = [];
    for (const wsId of workspaceIds) {
      for (const doc of this.workspace(wsId).values()) {
        if (!doc.deleted) out.push(structuredClone(doc));
      }
    }
    return sortDocs(out);
  }

  async getDocument(workspaceIds, id) {
    for (const wsId of workspaceIds) {
      const doc = this.workspace(wsId).get(id);
      if (doc && !doc.deleted) return structuredClone(doc);
    }
    return null;
  }

  async createDocument(workspaceId, doc, limits = null) {
    const ws = this.workspace(workspaceId);
    const existing = ws.get(doc.id);
    if (existing && !existing.deleted) throw new DuplicateDocumentError(doc.id);

    const key = this.keys.get(workspaceId);
    const byteSize = Buffer.byteLength(JSON.stringify(doc), 'utf8');
    if (limits && key) {
      if (key.docCount >= limits.maxDocuments) {
        throw new QuotaExceededError('document', { documents: key.docCount, maxDocuments: limits.maxDocuments });
      }
      if (key.storageBytes + byteSize > limits.maxStorageBytes) {
        throw new StorageQuotaExceededError({ storageBytes: key.storageBytes, maxStorageBytes: limits.maxStorageBytes });
      }
    }

    const record = { ...structuredClone(doc), workspace: workspaceId, deleted: false };
    if (existing) {
      // Tombstone resurrection: history continues, version stays monotonic.
      record.version = existing.version + 1;
      record.checksum = checksum(record);
    }
    ws.set(doc.id, record);
    this.appendRevision(workspaceId, record);
    if (key) {
      key.docCount += 1;
      key.storageBytes += byteSize;
    }
    return structuredClone(record);
  }

  async updateDocument(workspaceId, id, fields, expectedVersion, limits = null) {
    const ws = this.workspace(workspaceId);
    const existing = ws.get(id);
    if (!existing || existing.deleted) throw new DocumentNotFoundError(id);
    if (existing.version !== expectedVersion) throw new VersionConflictError(existing.version);

    const updated = {
      ...existing,
      ...fields,
      id,
      workspace: workspaceId,
      version: existing.version + 1,
      updatedAt: new Date().toISOString(),
      deleted: false
    };
    updated.checksum = checksum(updated);

    const key = this.keys.get(workspaceId);
    // Storage accounting is a delta, not the new document's full size: an
    // edit only costs (or frees) the difference from what it already
    // occupied. Only a growing edit can be blocked by the quota.
    const delta = Buffer.byteLength(JSON.stringify(updated), 'utf8')
      - Buffer.byteLength(JSON.stringify(existing), 'utf8');
    if (limits && key && delta > 0 && key.storageBytes + delta > limits.maxStorageBytes) {
      throw new StorageQuotaExceededError({ storageBytes: key.storageBytes, maxStorageBytes: limits.maxStorageBytes });
    }

    ws.set(id, updated);
    this.appendRevision(workspaceId, updated);
    if (key) key.storageBytes = Math.max(0, key.storageBytes + delta);
    return structuredClone(updated);
  }

  async deleteDocument(workspaceId, id) {
    const ws = this.workspace(workspaceId);
    const existing = ws.get(id);
    if (!existing || existing.deleted) throw new DocumentNotFoundError(id);

    const tombstone = {
      ...existing,
      version: existing.version + 1,
      updatedAt: new Date().toISOString(),
      deleted: true
    };
    ws.set(id, tombstone);
    this.appendRevision(workspaceId, tombstone);
    // Tombstones free BOTH document quota and the live doc's storage bytes.
    // Storage meters live content (updateDocument charges deltas, not full
    // snapshots) — without this release, every delete+recreate cycle
    // double-charged the same bytes. Math.max guards the slight difference
    // between the create-time and delete-time size bases.
    const key = this.keys.get(workspaceId);
    if (key) {
      key.docCount = Math.max(0, key.docCount - 1);
      key.storageBytes = Math.max(0, key.storageBytes - Buffer.byteLength(JSON.stringify(existing), 'utf8'));
    }
    return { id, version: tombstone.version, deleted: true };
  }

  async getHistory(workspaceIds, id) {
    for (const wsId of workspaceIds) {
      const log = this.revisions.get(`${wsId}/${id}`);
      if (log && log.length > 0) {
        return log.map((rev) => structuredClone(rev));
      }
    }
    return null;
  }

  async findKeyByHash(keyHash) {
    const keyId = this.keyHashes.get(keyHash);
    if (!keyId) return null;
    return structuredClone(this.keys.get(keyId));
  }

  async createKey({ id, plan = 'demo', keyHash, actor = 'system' }) {
    const keyId = id || `ws-${Math.random().toString(36).slice(2, 10)}`;
    const key = {
      id: keyId,
      plan,
      status: 'active',
      createdAt: new Date().toISOString(),
      docCount: 0,
      storageBytes: 0
    };
    this.keys.set(keyId, key);
    if (keyHash) this.keyHashes.set(keyHash, keyId);
    void actor; // audited in PgStore's key_audit; MemoryStore is ephemeral
    return structuredClone(key);
  }

  // --- M2 domains: usage counters, Stripe lifecycle -------------------------

  async recordPackPull(keyId, month, limit) {
    if (!this.usage) this.usage = new Map();
    const usageKey = `${keyId}/${month}`;
    const current = this.usage.get(usageKey) || 0;
    if (current >= limit) {
      throw new QuotaExceededError('pack pulls', { packPulls: current, packPullsPerMonth: limit });
    }
    this.usage.set(usageKey, current + 1);
    return { packPulls: current + 1 };
  }

  async getUsage(keyId, month) {
    const key = this.keys.get(keyId);
    if (!key) return null;
    const packPulls = this.usage?.get(`${keyId}/${month}`) || 0;
    return {
      plan: key.plan,
      status: key.status,
      docCount: key.docCount,
      storageBytes: key.storageBytes,
      packPulls,
      month
    };
  }

  // Cumulative usage for a key across ALL months (getUsage is current-month
  // only). Pack-pull counts live in monthly usage rows; doc_count/storage are
  // lifetime on the key. Null for an unknown key id.
  async getCumulativeUsage(keyId) {
    const key = this.keys.get(keyId);
    if (!key) return null;
    const months = [];
    let totalPackPulls = 0;
    for (const [usageKey, packPulls] of this.usage || []) {
      if (usageKey.startsWith(`${keyId}/`)) {
        months.push({ month: usageKey.slice(keyId.length + 1), packPulls });
        totalPackPulls += packPulls;
      }
    }
    months.sort((a, b) => a.month.localeCompare(b.month));
    return {
      keyId,
      plan: key.plan,
      status: key.status,
      docCount: key.docCount,
      storageBytes: key.storageBytes,
      totalPackPulls,
      months
    };
  }

  // Returns true when the event is new; false when already processed (no-op).
  async markStripeEvent(eventId, created) {
    if (!this.stripeEvents) this.stripeEvents = new Map();
    if (this.stripeEvents.has(eventId)) return false;
    this.stripeEvents.set(eventId, created);
    return true;
  }

  async getKeyById(keyId) {
    const key = this.keys.get(keyId);
    return key ? structuredClone(key) : null;
  }

  async findKeyByCustomer(stripeCustomerId) {
    for (const key of this.keys.values()) {
      if (key.stripeCustomerId === stripeCustomerId) return structuredClone(key);
    }
    return null;
  }

  // Idempotent: checkout webhook and claim endpoint both upsert, whichever
  // lands first wins and the other is a no-op (design: claim race).
  async upsertPendingKey({ customerId, subscriptionId, plan, eventCreated }) {
    const existing = await this.findKeyByCustomer(customerId);
    if (existing) return existing;
    const key = {
      id: `ws-${Math.random().toString(36).slice(2, 10)}`,
      plan,
      status: 'pending_claim',
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId || null,
      lastEventCreated: eventCreated ?? null,
      createdAt: new Date().toISOString(),
      docCount: 0,
      storageBytes: 0
    };
    this.keys.set(key.id, key);
    return structuredClone(key);
  }

  async activateKey(keyId, keyHash, actor = 'claim') {
    const key = this.keys.get(keyId);
    if (!key || key.status !== 'pending_claim') throw new AlreadyClaimedError();
    key.status = 'active';
    this.keyHashes.set(keyHash, keyId);
    void actor;
    return structuredClone(key);
  }

  // Out-of-order Stripe events resolve by event `created`: stale events are
  // dropped (design decision OV-E1.3 via keys.last_event_created).
  async updateSubscriptionState(customerId, { plan, status, cancelledAt, eventCreated }) {
    const key = await this.findKeyByCustomer(customerId);
    if (!key) return null;
    const live = this.keys.get(key.id);
    if (live.lastEventCreated != null && eventCreated != null && eventCreated <= live.lastEventCreated) {
      return structuredClone(live); // stale event — no-op
    }
    if (plan) live.plan = plan;
    if (status) live.status = status;
    // Explicit cancelledAt wins; reactivation clears it (same rule as PgStore).
    if (cancelledAt != null) live.cancelledAt = cancelledAt;
    else if (status === 'active') live.cancelledAt = null;
    if (eventCreated != null) live.lastEventCreated = eventCreated;
    return structuredClone(live);
  }

  async rotateKeyHash(keyId, newHash, actor = 'rotate') {
    const key = this.keys.get(keyId);
    if (!key) return null;
    for (const [hash, id] of this.keyHashes) {
      if (id === keyId) this.keyHashes.delete(hash);
    }
    this.keyHashes.set(newHash, keyId);
    key.rotatedAt = new Date().toISOString();
    void actor;
    return structuredClone(key);
  }

  // Operator off-switch: revoke (full cut), read_only (freeze writes, keep
  // reads), or active (reactivate). Returns null for an unknown key id so the
  // CLI can report "no such key" without a thrown error.
  async setKeyStatus(keyId, status, actor = 'admin-script') {
    if (!OPERATOR_SETTABLE_STATUSES.has(status)) {
      throw new Error(`invalid status "${status}" (expected: ${[...OPERATOR_SETTABLE_STATUSES].join(', ')})`);
    }
    const key = this.keys.get(keyId);
    if (!key || PROTECTED_KEY_STATUSES.has(key.status)) return null;
    key.status = status;
    void actor;
    return structuredClone(key);
  }
}
