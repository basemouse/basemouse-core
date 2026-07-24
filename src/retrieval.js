// Retrieval-mode adapter for BaseMouse.
//
// This is the API-facing seam for hybrid / GraphRAG retrieval. Validation and
// env-gated local vector wiring live here so HTTP/client code stays small; the
// actual pure, dependency-free hybrid ranker lives in basemouse-core.js and the
// pure local embedding model lives in embeddings.js.

import { cosineSimilarity, hybridSearchRepository as coreHybridSearchRepository } from './basemouse-core.js';
import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  EMBEDDING_BACKEND,
  embedDocument,
  embedQuery,
  resolveDimensions
} from './embeddings.js';

export const RETRIEVAL_MODES = Object.freeze(['lexical', 'hybrid']);

// Local vector retrieval is on by default: it is pure, deterministic, and never
// touches the network, so it is safe in production. Operators can disable it
// with BASEMOUSE_VECTOR_RETRIEVAL=off (graph + lexical hybrid still work).
export const VECTOR_RETRIEVAL_MODES = Object.freeze(['local', 'off']);

// Cosine collisions in a hashed feature space are unavoidable; require a small
// minimum similarity before a doc earns a vector signal, so a garbage query does
// not pull in unrelated docs purely through bucket collisions.
export const DEFAULT_MIN_VECTOR_SCORE = 0.12;

// Resolve the configured vector-retrieval backend. Default is 'local'; only an
// explicit 'off' disables it. Unknown values fall back to the safe default.
export function vectorRetrievalMode(env = process.env) {
  const raw = String(env?.BASEMOUSE_VECTOR_RETRIEVAL ?? '').trim().toLowerCase();
  return raw === 'off' ? 'off' : 'local';
}

// Resolve the embedding dimensionality from env, clamped to a sane range.
export function vectorRetrievalDimensions(env = process.env) {
  return resolveDimensions(env?.BASEMOUSE_VECTOR_DIMENSIONS ?? DEFAULT_EMBEDDING_DIMENSIONS);
}

// Describe the active vector backend for API metadata, or null when disabled.
export function vectorRetrievalInfo(env = process.env) {
  if (vectorRetrievalMode(env) === 'off') return null;
  return { backend: EMBEDDING_BACKEND, dimensions: vectorRetrievalDimensions(env) };
}

// Validate a retrieval-mode query param. Returns { ok, value } with a default of
// 'lexical' (back-compatible), or { ok:false, error } for unknown modes — the
// same shape as validateFacet/validateQuery in basemouse-core.js.
export function validateRetrieval(raw, { fallback = 'lexical' } = {}) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === '') return { ok: true, value: fallback };
  if (!RETRIEVAL_MODES.includes(value)) {
    return { ok: false, error: `retrieval must be one of ${RETRIEVAL_MODES.join(', ')}` };
  }
  return { ok: true, value };
}

// Compute local vector scores for `query` against `items` using the offline
// hashed-feature embedding model. Returns an { id -> cosineScore } map (only
// entries at or above the threshold) or null when vector retrieval is disabled
// or the query is empty. Pure and synchronous — no network, safe in request
// paths.
export function localVectorScores(items, query, options = {}) {
  const env = options.env ?? process.env;
  if (vectorRetrievalMode(env) === 'off') return null;
  const text = String(query ?? '').trim();
  if (!text) return null;

  const dimensions = options.dimensions != null
    ? resolveDimensions(options.dimensions)
    : vectorRetrievalDimensions(env);
  const minScore = typeof options.minScore === 'number' ? options.minScore : DEFAULT_MIN_VECTOR_SCORE;

  const queryVector = embedQuery(text, { dimensions });
  const scores = {};
  let any = false;
  for (const item of items || []) {
    if (!item || item.id == null) continue;
    const sim = cosineSimilarity(embedDocument(item, { dimensions }), queryVector);
    if (sim >= minScore) {
      scores[item.id] = sim;
      any = true;
    }
  }
  return any ? scores : null;
}

// API-facing hybrid mode defaults graph expansion ON. Lower-level core callers
// can still call coreHybridSearchRepository(..., { graph: false }) for pure
// lexical+vector experiments. Vector scores are NOT injected here — pass an
// explicit `vectorScores`/`embeddings` option, or use hybridSearchWithVectors
// for the env-gated local vector index.
export function hybridSearchRepository(items, query, options = {}) {
  return coreHybridSearchRepository(items, query, { graph: true, ...options });
}

// Hybrid retrieval with the env-gated local vector index folded in. When local
// vector retrieval is enabled and the caller has not supplied their own vector
// signal, this builds offline embeddings for the visible docs + query and feeds
// them through the existing vector path, so hybrid results carry `vector`
// signals alongside `lexical`/`graph`. With BASEMOUSE_VECTOR_RETRIEVAL=off this
// degrades to graph+lexical hybrid, unchanged.
export function hybridSearchWithVectors(items, query, options = {}) {
  const { env, ...rest } = options;
  const opts = { graph: true, ...rest };
  const callerSuppliedVectors = 'vectorScores' in opts
    || ('embeddings' in opts && 'queryVector' in opts);
  if (!callerSuppliedVectors) {
    const scores = localVectorScores(items, query, { env });
    if (scores) opts.vectorScores = scores;
  }
  return coreHybridSearchRepository(items, query, opts);
}
