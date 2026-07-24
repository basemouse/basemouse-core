// Named error classes — the error-handling contract from
// docs/designs/real-service-core.md ("Error & Rescue Registry").
// Every failure mode the API can hit has a class, an HTTP status, and a
// stable `code` string. Handlers throw these; the server maps them to
// responses. Catch-alls are banned: anything not in this registry is a bug
// and surfaces as 500 internal_error.

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export class StoreUnavailableError extends ApiError {
  constructor(cause) {
    super(503, 'service_unavailable', 'The document store is temporarily unavailable. Retry shortly.', {
      headers: { 'Retry-After': '5' }
    });
    this.cause = cause;
  }
}

export class DuplicateDocumentError extends ApiError {
  constructor(id) {
    super(409, 'duplicate_id', `a document with id "${id}" already exists in this workspace`);
  }
}

export class VersionConflictError extends ApiError {
  constructor(currentVersion) {
    super(409, 'version_conflict', 'expectedVersion does not match the current document version', {
      currentVersion
    });
  }
}

export class DocumentNotFoundError extends ApiError {
  constructor(id) {
    super(404, 'not_found', `no document with id "${id}" in your visible workspaces`);
  }
}

// Surfaced by the version-free upsert when its bounded convergence retries are
// exhausted — the caller was told it needs no version, so it must never see
// expectedVersion vocabulary. Retryable by design.
export class ConcurrentWriteError extends ApiError {
  constructor(id) {
    super(409, 'concurrent_write', `document "${id}" is being modified concurrently — retry the upsert`);
  }
}

export class ValidationError extends ApiError {
  constructor(message) {
    super(400, 'invalid_document', message);
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = 'a valid API key is required (Authorization: Bearer bm_...)') {
    super(401, 'unauthorized', message);
  }
}

// Cancellation policy (OV5): read-only immediately, 90-day grace before purge.
const GRACE_PERIOD_DAYS = 90;

export class ReadOnlyKeyError extends ApiError {
  constructor(cancelledAt = null) {
    const graceEndsAt = cancelledAt
      ? new Date(new Date(cancelledAt).getTime() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString()
      : null;
    super(403, 'read_only_key', 'this key is read-only (subscription cancelled); reads and export keep working', {
      graceEndsAt
    });
  }
}

export class QuotaExceededError extends ApiError {
  constructor(kind, usage = {}) {
    super(402, 'quota_exceeded', `your plan's ${kind} quota is exhausted`, { quota: kind, ...usage });
  }
}

export class StorageQuotaExceededError extends ApiError {
  constructor(usage = {}) {
    super(402, 'storage_quota_exceeded', "your plan's storage allowance is exhausted (history is never deleted — upgrade or export)", usage);
  }
}

export class StripeUnavailableError extends ApiError {
  constructor(cause) {
    super(503, 'stripe_unavailable', 'Your payment is safe. We could not finish issuing your key — retry in a minute.', {
      headers: { 'Retry-After': '60' }
    });
    this.cause = cause;
  }
}

export class InvalidSessionError extends ApiError {
  constructor() {
    super(403, 'invalid_session', 'this checkout session is unknown or unpaid');
  }
}

export class AlreadyClaimedError extends ApiError {
  constructor() {
    super(409, 'already_claimed', 'a key was already issued for this purchase — it is shown exactly once; contact support if you lost it');
  }
}

export class WebhookSignatureError extends ApiError {
  constructor() {
    super(400, 'invalid_signature', 'webhook signature verification failed');
  }
}

// Map an unknown thrown value onto a response. ApiError instances carry their
// own contract; anything else is logged with context and becomes a 500.
export function toResponse(error, context) {
  if (error instanceof ApiError) {
    const { headers = {}, ...fields } = error.extra;
    return {
      status: error.status,
      payload: { error: error.code, message: error.message, ...fields },
      headers
    };
  }
  console.error(`internal_error during ${context}:`, error);
  return { status: 500, payload: { error: 'internal_error' }, headers: {} };
}
