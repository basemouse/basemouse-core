import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RETRIEVAL_MODES,
  VECTOR_RETRIEVAL_MODES,
  validateRetrieval,
  hybridSearchRepository,
  hybridSearchWithVectors,
  localVectorScores,
  vectorRetrievalInfo,
  vectorRetrievalMode
} from '../src/retrieval.js';
import { EMBEDDING_BACKEND } from '../src/embeddings.js';
import { createSeedRepository } from '../src/store.js';

test('RETRIEVAL_MODES exposes lexical and hybrid', () => {
  assert.deepEqual([...RETRIEVAL_MODES].sort(), ['hybrid', 'lexical']);
});

test('validateRetrieval defaults to lexical and is case-insensitive', () => {
  assert.deepEqual(validateRetrieval(undefined), { ok: true, value: 'lexical' });
  assert.deepEqual(validateRetrieval(''), { ok: true, value: 'lexical' });
  assert.deepEqual(validateRetrieval(null), { ok: true, value: 'lexical' });
  assert.deepEqual(validateRetrieval('hybrid'), { ok: true, value: 'hybrid' });
  assert.deepEqual(validateRetrieval('  HYBRID '), { ok: true, value: 'hybrid' });
  assert.deepEqual(validateRetrieval('lexical'), { ok: true, value: 'lexical' });
});

test('validateRetrieval rejects unknown modes', () => {
  const bad = validateRetrieval('semantic');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /retrieval/);
});

test('hybridSearchRepository keeps lexical hits and annotates them with a lexical signal', () => {
  const repository = createSeedRepository();
  const results = hybridSearchRepository(repository, 'agent context');
  const hit = results.find((r) => r.id === 'agent-context-engine');
  assert.ok(hit, 'lexical match is present');
  assert.equal(hit.retrieval.mode, 'hybrid');
  assert.ok(hit.retrieval.signals.includes('lexical'));
  assert.ok(hit.matchedTerms.includes('context'));
  assert.ok(typeof hit.score === 'number' && hit.score > 0);
});

test('hybridSearchRepository expands one hop along links and explains the graph signal', () => {
  // memory-capsules links to agent-context-engine; a "memory capsules" lexical
  // query should pull that neighbor in via the graph even though it does not
  // match the query terms itself.
  const repository = createSeedRepository();
  const results = hybridSearchRepository(repository, 'memory capsules');
  const graphEntry = results.find((r) => r.retrieval.signals.includes('graph'));
  assert.ok(graphEntry, 'at least one entry is pulled in via graph expansion');
  assert.equal(graphEntry.retrieval.mode, 'hybrid');
  assert.ok(graphEntry.retrieval.reasons.some((reason) => /graph neighbor/.test(reason)));
  // Graph-only neighbors carry graph source score but no lexical terms.
  assert.deepEqual(graphEntry.matchedTerms, []);
  assert.ok(graphEntry.retrieval.sourceScores.graph > 0);
});

test('hybridSearchRepository returns nothing when there are no lexical anchors', () => {
  assert.deepEqual(hybridSearchRepository(createSeedRepository(), 'qqqzzzxyw'), []);
});

test('hybridSearchRepository does not duplicate a doc that is both a hit and a neighbor', () => {
  const items = [
    { id: 'a', title: 'Alpha agent', type: 'note', body: 'agent alpha', links: ['b'] },
    { id: 'b', title: 'Beta agent', type: 'note', body: 'agent beta', links: ['a'] }
  ];
  const results = hybridSearchRepository(items, 'agent');
  const ids = results.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids');
  // Both matched lexically, so neither should be downgraded to a graph signal.
  assert.ok(results.every((r) => r.retrieval.signals.includes('lexical')));
});

// --- Local vector retrieval -------------------------------------------------

test('VECTOR_RETRIEVAL_MODES exposes local and off', () => {
  assert.deepEqual([...VECTOR_RETRIEVAL_MODES].sort(), ['local', 'off']);
});

test('vectorRetrievalMode defaults to local and only off disables it', () => {
  assert.equal(vectorRetrievalMode({}), 'local');
  assert.equal(vectorRetrievalMode({ BASEMOUSE_VECTOR_RETRIEVAL: '' }), 'local');
  assert.equal(vectorRetrievalMode({ BASEMOUSE_VECTOR_RETRIEVAL: 'local' }), 'local');
  assert.equal(vectorRetrievalMode({ BASEMOUSE_VECTOR_RETRIEVAL: ' OFF ' }), 'off');
  // Unknown values fall back to the safe default rather than erroring.
  assert.equal(vectorRetrievalMode({ BASEMOUSE_VECTOR_RETRIEVAL: 'openai' }), 'local');
});

test('vectorRetrievalInfo reports the local hashed backend, or null when off', () => {
  const info = vectorRetrievalInfo({ BASEMOUSE_VECTOR_RETRIEVAL: 'local' });
  assert.equal(info.backend, EMBEDDING_BACKEND);
  assert.ok(Number.isInteger(info.dimensions) && info.dimensions > 0);
  assert.equal(vectorRetrievalInfo({ BASEMOUSE_VECTOR_RETRIEVAL: 'off' }), null);
});

test('localVectorScores scores relevant docs and is null when disabled', () => {
  const repository = createSeedRepository();
  const scores = localVectorScores(repository, 'memory capsules', { env: { BASEMOUSE_VECTOR_RETRIEVAL: 'local' } });
  assert.ok(scores && typeof scores === 'object');
  assert.ok(scores['memory-capsules'] > 0, 'on-topic doc earns a vector score');
  assert.ok(Object.values(scores).every((v) => v > 0 && v <= 1), 'scores are cosine values');

  assert.equal(localVectorScores(repository, 'memory capsules', { env: { BASEMOUSE_VECTOR_RETRIEVAL: 'off' } }), null);
  assert.equal(localVectorScores(repository, '   ', { env: { BASEMOUSE_VECTOR_RETRIEVAL: 'local' } }), null);
});

test('hybridSearchWithVectors adds a vector signal alongside lexical/graph', () => {
  const repository = createSeedRepository();
  const results = hybridSearchWithVectors(repository, 'memory capsules', { env: { BASEMOUSE_VECTOR_RETRIEVAL: 'local' } });
  const hit = results.find((r) => r.id === 'memory-capsules');
  assert.ok(hit, 'on-topic doc is present');
  assert.ok(hit.retrieval.signals.includes('vector'), 'vector signal present');
  assert.ok(hit.retrieval.sourceScores.vector > 0);
  // Graph expansion still contributes its own signal somewhere in the results.
  assert.ok(results.some((r) => r.retrieval.signals.includes('graph')), 'graph hybrid still works');
});

test('hybridSearchWithVectors omits vector signals when retrieval is off but keeps graph hybrid', () => {
  const repository = createSeedRepository();
  const results = hybridSearchWithVectors(repository, 'memory capsules', { env: { BASEMOUSE_VECTOR_RETRIEVAL: 'off' } });
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => !r.retrieval.signals.includes('vector')), 'no vector signal when off');
  assert.ok(results.some((r) => r.retrieval.signals.includes('graph')), 'graph hybrid still works with vectors off');
});

test('hybridSearchWithVectors respects a caller-supplied vector signal', () => {
  const items = [
    { id: 'a', title: 'Alpha', type: 'note', body: 'alpha', links: [] },
    { id: 'delta', title: 'Delta', type: 'note', body: 'unrelated', links: [] }
  ];
  // Caller supplies an explicit vector score; the local index must not override it.
  const results = hybridSearchWithVectors(items, 'alpha', {
    env: { BASEMOUSE_VECTOR_RETRIEVAL: 'local' },
    vectorScores: { delta: 0.9 }
  });
  const delta = results.find((r) => r.id === 'delta');
  assert.ok(delta, 'doc surfaced purely by the caller-supplied vector score');
  assert.ok(delta.retrieval.signals.includes('vector'));
});
