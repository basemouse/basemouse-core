// Document CRUD + history handlers (design doc: M1). server.js routes here;
// this module owns validation and store calls, throwing the named errors
// from src/errors.js. Single-concern module in the billing.js/telemetry.js
// style (eng-review decision 3A).
//
//  POST   /api/documents                  create (resurrects tombstoned ids)
//  PUT    /api/documents/:id              update, optimistic lock (expectedVersion)
//  PUT    /api/documents/:id?mode=upsert  idempotent upsert (design doc D9):
//                                         created / updated / unchanged, no
//                                         expectedVersion needed
//  GET    /api/documents/:id              current revision
//  DELETE /api/documents/:id              tombstone (history preserved)
//  GET    /api/documents/:id/history      full revision history

import { randomBytes } from 'node:crypto';
import { normalizeDocument } from '../store.js';
import {
  ConcurrentWriteError,
  DocumentNotFoundError,
  DuplicateDocumentError,
  ReadOnlyKeyError,
  UnauthorizedError,
  ValidationError,
  VersionConflictError
} from '../errors.js';
import { visibleWorkspaces } from '../auth.js';

export const MAX_DOC_BODY_BYTES = 256 * 1024; // documents, vs 4 KB checkout cap

function requireWriteAuth(auth) {
  if (!auth) throw new UnauthorizedError('writes require an API key');
  if (auth.readOnly) throw new ReadOnlyKeyError(auth.cancelledAt);
  return auth.keyId;
}

// Validate an API document payload by reusing the seed normalizer, then stamp
// API provenance. Server generates an id when the client doesn't supply one.
function normalizeApiDocument(payload, workspaceId, { isUpdate = false } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ValidationError('request body must be a JSON document object');
  }
  const raw = { ...payload };
  delete raw.expectedVersion;
  if (!isUpdate && typeof raw.id !== 'string') {
    raw.id = `doc-${randomBytes(4).toString('hex')}`;
  }
  if (!isUpdate) raw.version = 1;

  const now = new Date().toISOString();
  raw.createdAt = raw.createdAt || now;
  raw.updatedAt = now;

  let doc;
  try {
    doc = normalizeDocument(raw, { file: '<api>' });
  } catch (error) {
    throw new ValidationError(String(error.message).replace(/^invalid seed document <api>: /, ''));
  }
  doc.source = { kind: 'api', workspace: workspaceId };
  return doc;
}

export async function createDocumentHandler(store, auth, payload, limits = null) {
  const workspaceId = requireWriteAuth(auth);
  const doc = normalizeApiDocument(payload, workspaceId);
  // Quota limits are enforced INSIDE the store transaction (exact under any
  // concurrency); the handler just resolves which plan's limits apply.
  const created = await store.createDocument(workspaceId, doc, limits);
  return { status: 201, body: created };
}

export async function updateDocumentHandler(store, auth, id, payload, ifMatchHeader, limits = null) {
  const workspaceId = requireWriteAuth(auth);

  const expectedRaw = payload?.expectedVersion ?? ifMatchHeader;
  const expectedVersion = Number.parseInt(expectedRaw, 10);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new ValidationError('expectedVersion (body) or If-Match (header) with the current version is required');
  }

  const existing = await store.getDocument([workspaceId], id);
  if (!existing) throw new DocumentNotFoundError(id);
  if (existing.version !== expectedVersion) throw new VersionConflictError(existing.version);

  const merged = normalizeApiDocument(
    { ...existing, ...payload, id, version: existing.version },
    workspaceId,
    { isUpdate: true }
  );
  const updated = await store.updateDocument(workspaceId, id, pickContent(merged), expectedVersion, limits);
  return { status: 200, body: updated };
}

// The content fields writes compare and persist — the ONE owner of the list
// (both update paths and the comparison derive from it, so they can never
// disagree on the field set). Version, timestamps, and provenance are
// server-owned and never part of the "did it change" question.
const CONTENT_FIELDS = ['title', 'type', 'tags', 'body', 'links', 'author'];

const pickContent = (doc) => Object.fromEntries(CONTENT_FIELDS.map((field) => [field, doc[field]]));

function sameContent(a, b) {
  return CONTENT_FIELDS.every((field) => {
    if (field === 'tags' || field === 'links') {
      return JSON.stringify(a[field] ?? []) === JSON.stringify(b[field] ?? []);
    }
    return (a[field] ?? null) === (b[field] ?? null);
  });
}

// Idempotent upsert (design doc: server-side-ingestion.md D9). One server-owned
// primitive instead of the client-side create→409→history→compare→PUT dance:
// the comparison lives next to the normalization it must match, clients stop
// byte-replicating trim semantics, and an unchanged write never grows the
// append-only history.
// NOTE: this is a handler-level read→compare→write with a bounded convergence
// retry, not the in-store-transaction compare the D9 design sketches. The
// deviation is deliberate (no store API change yet) and recorded in the design
// doc; the residual gap is that an `unchanged` reply reflects the read
// snapshot, which a concurrent writer may have superseded by the time the
// response lands. Moving the compare into a store-level upsert closes it.
export async function upsertDocumentHandler(store, auth, id, payload, ifMatchHeader, limits = null) {
  const workspaceId = requireWriteAuth(auth);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ValidationError('request body must be a JSON document object');
  }
  if (typeof payload.id === 'string' && payload.id !== id) {
    throw new ValidationError('body id does not match the id in the URL');
  }
  // A version precondition contradicts upsert's version-free contract.
  // Silently discarding it would let a caller who believes they hold an
  // optimistic lock clobber newer content — reject loudly instead.
  if (payload.expectedVersion !== undefined || ifMatchHeader !== undefined) {
    throw new ValidationError('expectedVersion / If-Match are incompatible with mode=upsert — use plain PUT for optimistic locking');
  }
  // Validate tags BEFORE the merge loop ever iterates them: strings are
  // iterable (tags:"prod" would merge as single characters) and non-iterables
  // would throw a raw TypeError → 500. Same rule the normalizer enforces.
  if (payload.tags !== undefined && (!Array.isArray(payload.tags) || payload.tags.some((tag) => typeof tag !== 'string'))) {
    throw new ValidationError('tags must be an array of strings');
  }

  // Bounded convergence loop: re-read on ANY concurrent-write signal — a lost
  // optimistic lock (VersionConflictError), a lost create race
  // (DuplicateDocumentError), or a document tombstoned between our read and
  // write (DocumentNotFoundError from updateDocument; the re-read then takes
  // the create/resurrect path). After the retries, the conflict surfaces in
  // upsert vocabulary (ConcurrentWriteError, retryable 409) — never in the
  // expectedVersion terms this mode tells callers they don't need.
  const ATTEMPTS = 3;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const existing = await store.getDocument([workspaceId], id);
      if (!existing) {
        const doc = normalizeApiDocument({ ...payload, id }, workspaceId);
        const created = await store.createDocument(workspaceId, doc, limits);
        return { status: 201, body: { outcome: 'created', document: created } };
      }

      // Merge over the existing doc so omitted fields are preserved, and union
      // tags ADDITIVELY: upsert clients write without reading first, so replace
      // semantics would silently destroy tags added elsewhere (the exact bug
      // class the sync CLI hit). Authoritative replacement — including tag
      // removal — stays on plain PUT with expectedVersion.
      const tags = [...existing.tags];
      for (const tag of payload.tags ?? []) {
        if (!tags.includes(tag)) tags.push(tag);
      }
      const merged = normalizeApiDocument(
        { ...existing, ...payload, tags, id, version: existing.version },
        workspaceId,
        { isUpdate: true }
      );
      if (sameContent(merged, existing)) {
        return { status: 200, body: { outcome: 'unchanged', document: existing } };
      }

      const updated = await store.updateDocument(workspaceId, id, pickContent(merged), existing.version, limits);
      return { status: 200, body: { outcome: 'updated', document: updated } };
    } catch (error) {
      const retryable =
        error instanceof VersionConflictError ||
        error instanceof DuplicateDocumentError ||
        error instanceof DocumentNotFoundError;
      if (!retryable) throw error;
      if (attempt === ATTEMPTS - 1) throw new ConcurrentWriteError(id);
    }
  }
  // Unreachable: every loop iteration returns or throws.
  throw new ConcurrentWriteError(id);
}

// Single-document read over the caller's visible workspaces — the per-doc
// read clients previously faked by downloading the entire history.
export async function getDocumentHandler(store, auth, id) {
  const doc = await store.getDocument(visibleWorkspaces(auth), id);
  if (!doc) throw new DocumentNotFoundError(id);
  return { status: 200, body: doc };
}

export async function deleteDocumentHandler(store, auth, id) {
  const workspaceId = requireWriteAuth(auth);
  const tombstone = await store.deleteDocument(workspaceId, id);
  return { status: 200, body: tombstone };
}

export async function historyHandler(store, auth, id) {
  const history = await store.getHistory(visibleWorkspaces(auth), id);
  if (!history) throw new DocumentNotFoundError(id);
  return {
    status: 200,
    body: { id, revisions: history.length, history }
  };
}
