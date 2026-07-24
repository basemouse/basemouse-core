// Local, offline, dependency-free text embeddings for BaseMouse.
//
// These are *local hashed-feature* embeddings, NOT a semantic model: each token
// is hashed (the "hashing trick") into a fixed-dimension vector with a signed
// unit weight, so cosine similarity here measures shared-vocabulary overlap in a
// dense space — it does not capture synonymy or deep semantics. The point is a
// pure, deterministic, network-free vector signal that is stable across process
// restarts and that slots into the existing hybrid vector path, and that can be
// swapped for a real embedding provider later without touching callers.
//
// Node built-ins only. No filesystem, no network, no randomness.

import { tokenize } from './basemouse-core.js';

export const DEFAULT_EMBEDDING_DIMENSIONS = 64;
export const MIN_EMBEDDING_DIMENSIONS = 8;
export const MAX_EMBEDDING_DIMENSIONS = 1024;
export const EMBEDDING_BACKEND = 'local-hashed';

// Per-field weights when embedding a document — title/tags/type are stronger
// retrieval signals than free-text body, so they push harder on their buckets.
const FIELD_WEIGHTS = Object.freeze({ title: 2, type: 1.5, tags: 2, body: 1 });

// Clamp a requested dimension count to a sane integer, falling back to the
// default for anything missing or out of range. Deterministic and total.
export function resolveDimensions(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_EMBEDDING_DIMENSIONS || n > MAX_EMBEDDING_DIMENSIONS) {
    return DEFAULT_EMBEDDING_DIMENSIONS;
  }
  return n;
}

// FNV-1a 32-bit hash of a string — a fast, well-distributed, deterministic hash
// with no dependencies. Stable across processes and platforms (Math.imul keeps
// the multiply in 32-bit two's-complement).
function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// Feature-hash tokens into an existing vector: each token lands in one bucket
// (low hash bits) with a sign (top hash bit) and accumulates `weight`. Repeated
// tokens reinforce their bucket. Pure — mutates and returns the passed vector.
function hashTokensInto(vector, tokens, weight) {
  const dimensions = vector.length;
  for (const token of tokens) {
    const h = fnv1a(token);
    const bucket = h % dimensions;
    const sign = ((h >>> 31) & 1) ? -1 : 1;
    vector[bucket] += sign * weight;
  }
  return vector;
}

// Embed a free-text string into a dense vector. Used for queries and any plain
// text. Same tokenizer as the lexical scorer, so vocabulary lines up exactly.
export function embedText(text, options = {}) {
  const dimensions = resolveDimensions(options.dimensions);
  const vector = new Array(dimensions).fill(0);
  return hashTokensInto(vector, tokenize(text), 1);
}

// Embed a document from its title/type/tags/body with field weighting. The
// resulting vector is what the index stores per document id.
export function embedDocument(item, options = {}) {
  const dimensions = resolveDimensions(options.dimensions);
  const vector = new Array(dimensions).fill(0);
  hashTokensInto(vector, tokenize(item?.title), FIELD_WEIGHTS.title);
  hashTokensInto(vector, tokenize(item?.type), FIELD_WEIGHTS.type);
  hashTokensInto(vector, tokenize((item?.tags || []).join(' ')), FIELD_WEIGHTS.tags);
  hashTokensInto(vector, tokenize(item?.body), FIELD_WEIGHTS.body);
  return vector;
}

// Embed a search query. Distinct name from embedText for call-site clarity even
// though queries are plain text today.
export function embedQuery(query, options = {}) {
  return embedText(query, options);
}

// Build an in-memory embedding index over a set of documents. Returns the
// backend label, the dimension count actually used, and an { id -> vector } map
// ready to drop into hybridSearchRepository's `embeddings` option. Pure and
// synchronous — safe to call inside a request path (no I/O, no network).
export function buildEmbeddingIndex(items, options = {}) {
  const dimensions = resolveDimensions(options.dimensions);
  const embeddings = {};
  for (const item of items || []) {
    if (item && item.id != null) {
      embeddings[item.id] = embedDocument(item, { dimensions });
    }
  }
  return { backend: EMBEDDING_BACKEND, dimensions, embeddings };
}
