// Document CRUD + history handlers (design doc: M1). server.js routes here;
// this module owns validation and store calls, throwing the named errors
// from src/errors.js. Single-concern module in the billing.js/telemetry.js
// style (eng-review decision 3A).
//
//  POST   /api/documents              create (resurrects tombstoned ids)
//  PUT    /api/documents/:id          update, optimistic lock (expectedVersion)
//  DELETE /api/documents/:id          tombstone (history preserved)
//  GET    /api/documents/:id/history  full revision history

import { randomBytes } from 'node:crypto';
import { normalizeDocument } from '../store.js';
import {
  DocumentNotFoundError,
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

export async function updateDocumentHandler(store, auth, id, payload, ifMatchHeader) {
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
  const updated = await store.updateDocument(
    workspaceId,
    id,
    {
      title: merged.title,
      type: merged.type,
      tags: merged.tags,
      body: merged.body,
      links: merged.links,
      author: merged.author
    },
    expectedVersion
  );
  return { status: 200, body: updated };
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
