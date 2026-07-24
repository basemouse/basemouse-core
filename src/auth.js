// API-key authentication. Keys look like `bm_<48 hex chars>`; only their
// SHA-256 hash is stored (a leaked database doesn't leak usable keys). The
// lookup is a hash-index probe — there is no secret-vs-secret comparison
// left to time, so no constant-time machinery is needed here.
//
// Resolution result:
//   { keyId, plan, status, readOnly } when a valid key is presented
//   null when no Authorization header is present (anonymous)
//   throws UnauthorizedError for malformed/unknown/revoked keys

import { createHash, randomBytes } from 'node:crypto';
import { UnauthorizedError } from './errors.js';
import { PUBLIC_WORKSPACE } from './memory-store.js';

const KEY_PATTERN = /^bm_[0-9a-f]{48}$/;

export function generateKey() {
  return `bm_${randomBytes(24).toString('hex')}`;
}

export function hashKey(plaintext) {
  return createHash('sha256').update(plaintext).digest('hex');
}

export async function resolveKey(req, store) {
  const header = req.headers.authorization;
  if (!header) return null;

  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match || !KEY_PATTERN.test(match[1])) {
    throw new UnauthorizedError('malformed Authorization header (expected: Bearer bm_...)');
  }

  const key = await store.findKeyByHash(hashKey(match[1]));
  if (!key || key.status === 'revoked' || key.status === 'pending_claim' || key.status === 'system') {
    throw new UnauthorizedError();
  }
  return {
    keyId: key.id,
    plan: key.plan,
    status: key.status,
    readOnly: key.status === 'read_only',
    cancelledAt: key.cancelledAt || null
  };
}

// Workspaces visible to a request: the key's own workspace first (so private
// documents shadow public ones on id collisions), then the public corpus.
export function visibleWorkspaces(auth) {
  return auth ? [auth.keyId, PUBLIC_WORKSPACE] : [PUBLIC_WORKSPACE];
}
