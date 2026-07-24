import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONTEXT_PACK_SCHEMA,
  MAX_QUERY_LENGTH,
  cosineSimilarity,
  createContextPack,
  filterItems,
  hybridSearchRepository,
  resolveLimit,
  searchRepository,
  tokenize,
  validateFacet,
  validateQuery
} from '../src/basemouse-core.js';
import { createSeedRepository } from '../src/store.js';

test('tokenize removes stop words and punctuation', () => {
  assert.deepEqual(tokenize('The Agent-first context pack!'), ['agent-first', 'context', 'pack']);
});

test('searchRepository ranks matching BaseMouse concepts and reports matched terms', () => {
  const repository = createSeedRepository();
  const results = searchRepository(repository, 'agent context');
  assert.equal(results[0].id, 'agent-context-engine');
  assert.ok(results.length >= 2);
  assert.ok(results[0].matchedTerms.includes('context'));
  assert.ok(typeof results[0].score === 'number');
});

test('searchRepository returns nothing for an empty query', () => {
  assert.deepEqual(searchRepository(createSeedRepository(), '   '), []);
});

test('createContextPack emits v1 schema with citations and provenance', () => {
  const repository = createSeedRepository();
  const pack = createContextPack(repository, { query: 'memory', limit: 2 });
  assert.equal(pack.schema, CONTEXT_PACK_SCHEMA);
  assert.equal(pack.query, 'memory');
  assert.ok(pack.entryCount >= 1);
  assert.ok(pack.agentInstructions.length > 0);
  assert.equal(pack.entries[0].id, 'memory-capsules');

  const entry = pack.entries[0];
  assert.ok(entry.citation.label.startsWith('[memory-capsules]'));
  assert.equal(entry.provenance.source.kind, 'seed');
  assert.match(entry.provenance.checksum, /^[0-9a-f]{16}$/);
  assert.ok(entry.relevance.matchedTerms.includes('memory'));
  assert.deepEqual(pack.citations[0], entry.citation);
});

test('createContextPack without a query packs the whole repository up to the limit', () => {
  const repository = createSeedRepository();
  const pack = createContextPack(repository, { limit: 3 });
  assert.equal(pack.query, null);
  assert.equal(pack.entryCount, 3);
  assert.equal(pack.totalMatches, repository.length);
  assert.equal(pack.truncated, true);
  assert.equal(pack.entries[0].relevance.score, null);
});

test('createContextPack marks non-truncated packs', () => {
  const repository = createSeedRepository();
  const pack = createContextPack(repository, { limit: 50 });
  assert.equal(pack.truncated, false);
  assert.equal(pack.entryCount, repository.length);
});

test('searchRepository carries each item links through to results', () => {
  const repository = createSeedRepository();
  const results = searchRepository(repository, 'agent context');
  const hit = results.find((r) => r.id === 'agent-context-engine');
  assert.ok(Array.isArray(hit.links));
  assert.ok(hit.links.includes('hybrid-search'));
});

test('createContextPack adds links, related, and relationships graph data', () => {
  const items = [
    { id: 'a', title: 'Doc A', type: 'note', body: 'alpha', links: ['b', 'ghost'] },
    { id: 'b', title: 'Doc B', type: 'note', body: 'beta', links: ['a'] },
    { id: 'c', title: 'Doc C', type: 'note', body: 'gamma', links: [] }
  ];
  const pack = createContextPack(items, { limit: 2, generatedAt: '2026-06-08T00:00:00.000Z' });

  // Pack holds A and B (first two); C is excluded from the pack but is a repo doc.
  const entryA = pack.entries.find((e) => e.id === 'a');
  assert.deepEqual(entryA.links, ['b', 'ghost']);

  // Resolved + in-pack link.
  const linkB = entryA.related.find((r) => r.id === 'b');
  assert.deepEqual(linkB, { id: 'b', title: 'Doc B', inPack: true });

  // Dangling link resolves to title null and is not dropped.
  const linkGhost = entryA.related.find((r) => r.id === 'ghost');
  assert.deepEqual(linkGhost, { id: 'ghost', title: null, inPack: false });

  // Top-level relationships: deduped, sorted by from then to, with resolved flag.
  assert.deepEqual(pack.relationships, [
    { from: 'a', to: 'b', resolved: true },
    { from: 'a', to: 'ghost', resolved: false },
    { from: 'b', to: 'a', resolved: true }
  ]);
});

test('createContextPack related.inPack is false for repo docs left out of the pack', () => {
  const items = [
    { id: 'a', title: 'Doc A', type: 'note', body: 'alpha', links: ['c'] },
    { id: 'b', title: 'Doc B', type: 'note', body: 'beta', links: [] },
    { id: 'c', title: 'Doc C', type: 'note', body: 'gamma', links: [] }
  ];
  const pack = createContextPack(items, { limit: 2 });
  const linkC = pack.entries.find((e) => e.id === 'a').related.find((r) => r.id === 'c');
  // c is a real repo doc (title resolves) but not one of the packed entries.
  assert.deepEqual(linkC, { id: 'c', title: 'Doc C', inPack: false });
});

test('createContextPack instructs agents to use relationships for follow-up retrieval', () => {
  const pack = createContextPack([], {});
  assert.ok(pack.agentInstructions.some((line) => /relationships/.test(line)));
});

test('resolveLimit clamps, defaults, and rejects bad input', () => {
  assert.deepEqual(resolveLimit(undefined), { ok: true, value: 6 });
  assert.deepEqual(resolveLimit('3'), { ok: true, value: 3 });
  assert.deepEqual(resolveLimit('999'), { ok: true, value: 50 });
  assert.equal(resolveLimit('0').ok, false);
  assert.equal(resolveLimit('-2').ok, false);
  assert.equal(resolveLimit('abc').ok, false);
  assert.equal(resolveLimit('2.5').ok, false);
});

const FACET_ITEMS = [
  { id: 'a', title: 'A', type: 'feature', tags: ['Memory', 'agent'], body: 'x' },
  { id: 'b', title: 'B', type: 'note', tags: ['memory'], body: 'y' },
  { id: 'c', title: 'C', type: 'feature', tags: ['search'], body: 'z' }
];

test('filterItems with no filters is a no-op copy (no mutation)', () => {
  const out = filterItems(FACET_ITEMS, {});
  assert.deepEqual(out.map((i) => i.id), ['a', 'b', 'c']);
  assert.notEqual(out, FACET_ITEMS);
  assert.deepEqual(FACET_ITEMS.map((i) => i.id), ['a', 'b', 'c']);
});

test('filterItems narrows by type case-insensitively', () => {
  assert.deepEqual(filterItems(FACET_ITEMS, { type: 'FEATURE' }).map((i) => i.id), ['a', 'c']);
});

test('filterItems narrows by tag case-insensitively', () => {
  assert.deepEqual(filterItems(FACET_ITEMS, { tag: 'memory' }).map((i) => i.id), ['a', 'b']);
});

test('filterItems composes type AND tag', () => {
  assert.deepEqual(filterItems(FACET_ITEMS, { type: 'feature', tag: 'memory' }).map((i) => i.id), ['a']);
});

test('validateFacet accepts values and rejects overlong ones', () => {
  assert.deepEqual(validateFacet('  feature  ', 'type'), { ok: true, value: 'feature' });
  assert.deepEqual(validateFacet(null, 'tag'), { ok: true, value: '' });
  const tooLong = validateFacet('x'.repeat(MAX_QUERY_LENGTH + 1), 'type');
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.error, /type/);
});

test('createContextPack applies filters to the candidate set', () => {
  const pack = createContextPack(FACET_ITEMS, { filters: { type: 'feature' }, limit: 50 });
  assert.deepEqual(pack.filters, { type: 'feature', tag: null });
  assert.deepEqual(pack.entries.map((e) => e.id), ['a', 'c']);
  assert.equal(pack.totalMatches, 2);
  assert.equal(pack.truncated, false);
});

test('createContextPack filters compose with query and limit, keeping truncated correct', () => {
  const pack = createContextPack(FACET_ITEMS, { filters: { tag: 'memory' }, limit: 1 });
  assert.deepEqual(pack.filters, { type: null, tag: 'memory' });
  assert.equal(pack.totalMatches, 2);
  assert.equal(pack.entryCount, 1);
  assert.equal(pack.truncated, true);
});

test('createContextPack reports null filters when none given (backward compatible)', () => {
  const pack = createContextPack(FACET_ITEMS, { limit: 50 });
  assert.deepEqual(pack.filters, { type: null, tag: null });
  assert.equal(pack.totalMatches, FACET_ITEMS.length);
});

test('createContextPack defaults to lexical retrieval and includes explainable retrieval metadata', () => {
  const repository = createSeedRepository();
  const pack = createContextPack(repository, { query: 'memory', limit: 2 });
  assert.equal(pack.retrieval.mode, 'lexical');
  assert.ok(pack.entries.every((entry) => entry.retrieval?.mode === 'lexical'));
});

test('createContextPack records the retrieval mode and propagates entry retrieval metadata', () => {
  const items = [
    { id: 'a', title: 'Doc A', type: 'note', body: 'alpha', links: ['b'] },
    { id: 'b', title: 'Doc B', type: 'note', body: 'beta', links: [] }
  ];
  const pack = createContextPack(items, { query: 'alpha', limit: 5, retrieval: 'hybrid' });
  assert.equal(pack.retrieval.mode, 'hybrid');
  const entryB = pack.entries.find((e) => e.id === 'b');
  assert.ok(entryB.retrieval.signals.includes('graph'));
  const entryA = pack.entries.find((e) => e.id === 'a');
  assert.ok(entryA.retrieval.signals.includes('lexical'));
});

test('validateQuery enforces length and required flag', () => {
  assert.deepEqual(validateQuery('  hello  '), { ok: true, value: 'hello' });
  assert.deepEqual(validateQuery(null), { ok: true, value: '' });
  assert.equal(validateQuery('', { required: true }).ok, false);
  assert.equal(validateQuery('x'.repeat(MAX_QUERY_LENGTH + 1)).ok, false);
});

// --- Hybrid / GraphRAG retrieval ----------------------------------------------

// `alpha` is the only lexical match for "quantum"; it links to `beta`, which has
// no lexical overlap; `gamma` is unrelated and unlinked.
const GRAPH_ITEMS = [
  { id: 'alpha', title: 'Alpha', type: 'note', tags: ['x'], body: 'quantum widget flux', links: ['beta'] },
  { id: 'beta', title: 'Beta', type: 'note', tags: ['y'], body: 'unrelated penguin content', links: [] },
  { id: 'gamma', title: 'Gamma', type: 'note', tags: ['z'], body: 'nothing matching here', links: [] }
];

test('hybridSearchRepository surfaces a linked neighbor that did not lexically match', () => {
  const results = hybridSearchRepository(GRAPH_ITEMS, 'quantum', { graph: true });
  const ids = results.map((r) => r.id);
  assert.ok(ids.includes('alpha'), 'lexical seed is present');
  assert.ok(ids.includes('beta'), 'graph neighbor is pulled in');
  assert.ok(!ids.includes('gamma'), 'unrelated doc with no signal stays out');

  const beta = results.find((r) => r.id === 'beta');
  assert.deepEqual(beta.matchedTerms, [], 'neighbor did NOT lexically match');
  assert.ok(beta.retrieval.signals.includes('graph'));
  assert.ok(beta.score > 0);
});

test('hybridSearchRepository exposes retrieval signal provenance per result', () => {
  const results = hybridSearchRepository(GRAPH_ITEMS, 'quantum', { graph: true });
  const alpha = results.find((r) => r.id === 'alpha');
  assert.equal(alpha.retrieval.mode, 'hybrid');
  assert.ok(alpha.retrieval.signals.includes('lexical'));
  assert.ok(Array.isArray(alpha.retrieval.reasons) && alpha.retrieval.reasons.length > 0);
  assert.equal(typeof alpha.retrieval.sourceScores.lexical, 'number');
  // score is the sum of its per-signal source scores — explainable, not opaque.
  const sum = Object.values(alpha.retrieval.sourceScores).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(alpha.score - sum) < 1e-9);
});

test('hybridSearchRepository leaves graph expansion off unless enabled', () => {
  const results = hybridSearchRepository(GRAPH_ITEMS, 'quantum', {});
  assert.deepEqual(results.map((r) => r.id), ['alpha']);
});

test('searchRepository stays lexical-only and ignores graph neighbors (back-compat)', () => {
  const results = searchRepository(GRAPH_ITEMS, 'quantum');
  assert.deepEqual(results.map((r) => r.id), ['alpha']);
  // existing lexical result shape is untouched (no retrieval object injected).
  assert.equal(results[0].retrieval, undefined);
});

test('createContextPack default stays lexical and tags entries with a lexical retrieval mode', () => {
  const pack = createContextPack(GRAPH_ITEMS, { query: 'quantum' });
  assert.deepEqual(pack.entries.map((e) => e.id), ['alpha']);
  const entry = pack.entries[0];
  assert.deepEqual(entry.relevance.matchedTerms, ['quantum']);
  assert.equal(entry.retrieval.mode, 'lexical');
  assert.deepEqual(entry.retrieval.signals, ['lexical']);
  assert.equal(pack.retrieval.mode, 'lexical');
});

test('hybridSearchRepository accepts in-memory vector scores without network', () => {
  const items = [
    { id: 'alpha', title: 'Alpha', type: 'note', body: 'quantum widget', links: [] },
    { id: 'delta', title: 'Delta', type: 'note', body: 'totally different words', links: [] }
  ];
  // delta has no lexical overlap but a strong caller-supplied vector score.
  const results = hybridSearchRepository(items, 'quantum', { vectorScores: { delta: 0.9 } });
  const delta = results.find((r) => r.id === 'delta');
  assert.ok(delta, 'doc surfaced purely by the vector signal');
  assert.deepEqual(delta.matchedTerms, []);
  assert.ok(delta.retrieval.signals.includes('vector'));
  assert.ok(delta.retrieval.sourceScores.vector > 0);
});

test('hybridSearchRepository computes deterministic cosine similarity from an embeddings map', () => {
  const items = [
    { id: 'alpha', title: 'Alpha', type: 'note', body: 'quantum widget', links: [] },
    { id: 'delta', title: 'Delta', type: 'note', body: 'different', links: [] }
  ];
  // Deterministic fake vectors — no model calls.
  const embeddings = { alpha: [1, 0, 0], delta: [0, 1, 0] };
  const queryVector = [0, 1, 0]; // aligns with delta only
  const results = hybridSearchRepository(items, 'nomatch', { embeddings, queryVector });
  const delta = results.find((r) => r.id === 'delta');
  assert.ok(delta.retrieval.signals.includes('vector'));
  assert.ok(Math.abs(delta.retrieval.sourceScores.vector - 1) < 1e-9, 'cosine == 1');
  // alpha has neither a lexical match nor vector overlap → excluded.
  assert.ok(!results.some((r) => r.id === 'alpha'));
});

test('cosineSimilarity is pure, bounded, and zero for orthogonal/degenerate vectors', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-9);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2]), 0); // mismatched lengths
});

test('createContextPack with a retrieval option produces hybrid entries including graph neighbors', () => {
  const pack = createContextPack(GRAPH_ITEMS, { query: 'quantum', retrieval: { graph: true }, limit: 50 });
  const ids = pack.entries.map((e) => e.id);
  assert.ok(ids.includes('alpha'));
  assert.ok(ids.includes('beta'));

  const beta = pack.entries.find((e) => e.id === 'beta');
  assert.equal(beta.retrieval.mode, 'hybrid');
  assert.ok(beta.retrieval.signals.includes('graph'));
  assert.equal(beta.relevance.score, beta.retrieval.sourceScores.graph);
  assert.equal(pack.retrieval.mode, 'hybrid');
  assert.ok(pack.retrieval.signals.includes('graph'));
});

test('hybridSearchRepository sorts deterministically by score then title then id', () => {
  const items = [
    { id: 'b-doc', title: 'Same', type: 'note', body: 'quantum', links: [] },
    { id: 'a-doc', title: 'Same', type: 'note', body: 'quantum', links: [] }
  ];
  const forward = hybridSearchRepository(items, 'quantum', {});
  const reversed = hybridSearchRepository(items.slice().reverse(), 'quantum', {});
  assert.deepEqual(forward.map((r) => r.id), ['a-doc', 'b-doc']);
  assert.deepEqual(reversed.map((r) => r.id), ['a-doc', 'b-doc']);
});
