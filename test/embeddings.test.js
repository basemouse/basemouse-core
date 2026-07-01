import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  EMBEDDING_BACKEND,
  buildEmbeddingIndex,
  embedDocument,
  embedQuery,
  embedText,
  resolveDimensions
} from '../src/embeddings.js';
import { cosineSimilarity } from '../src/basemouse-core.js';

test('embedText is deterministic across calls and stable in shape', () => {
  const a = embedText('agent context memory');
  const b = embedText('agent context memory');
  assert.deepEqual(a, b, 'same input → identical vector');
  assert.equal(a.length, DEFAULT_EMBEDDING_DIMENSIONS);
  assert.ok(a.every((x) => typeof x === 'number' && Number.isFinite(x)));
  assert.ok(a.some((x) => x !== 0), 'non-empty text yields a non-zero vector');
});

test('embedText honors a configurable dimension count', () => {
  assert.equal(embedText('hello world', { dimensions: 32 }).length, 32);
  assert.equal(embedText('hello world', { dimensions: 128 }).length, 128);
  // Out-of-range / invalid dimensions fall back to the default.
  assert.equal(embedText('hello world', { dimensions: 0 }).length, DEFAULT_EMBEDDING_DIMENSIONS);
  assert.equal(embedText('hello world', { dimensions: 5 }).length, DEFAULT_EMBEDDING_DIMENSIONS);
  assert.equal(embedText('hello world', { dimensions: 'nope' }).length, DEFAULT_EMBEDDING_DIMENSIONS);
});

test('resolveDimensions clamps to a sane integer range', () => {
  assert.equal(resolveDimensions(undefined), DEFAULT_EMBEDDING_DIMENSIONS);
  assert.equal(resolveDimensions(64), 64);
  assert.equal(resolveDimensions(7), DEFAULT_EMBEDDING_DIMENSIONS);
  assert.equal(resolveDimensions(99999), DEFAULT_EMBEDDING_DIMENSIONS);
  assert.equal(resolveDimensions(12.5), DEFAULT_EMBEDDING_DIMENSIONS);
});

test('empty / whitespace text embeds to a zero vector', () => {
  assert.ok(embedText('').every((x) => x === 0));
  assert.ok(embedText('   ').every((x) => x === 0));
});

test('cosine similarity is highest for shared vocabulary, lowest for disjoint', () => {
  const query = embedQuery('agent context memory');
  const near = embedText('agent context memory capsules for agents');
  const related = embedText('agent prompts');
  const unrelated = embedText('quarterly invoice billing taxes');

  const simNear = cosineSimilarity(query, near);
  const simRelated = cosineSimilarity(query, related);
  const simUnrelated = cosineSimilarity(query, unrelated);

  assert.ok(simNear > simRelated, 'more shared terms → higher similarity');
  assert.ok(simRelated > simUnrelated, 'some overlap beats none');
  assert.ok(simNear > 0.5, 'strong overlap scores high');
  assert.ok(simUnrelated < 0.2, 'disjoint vocabulary scores low');
});

test('a document embeds near a query about its own title/tags', () => {
  const doc = {
    id: 'memory-capsules',
    title: 'Memory Capsules',
    type: 'feature',
    tags: ['memory', 'agents', 'portable'],
    body: 'Portable memory capsules let agents carry context between sessions.'
  };
  const docVec = embedDocument(doc);
  const onTopic = cosineSimilarity(docVec, embedQuery('memory capsules for agents'));
  const offTopic = cosineSimilarity(docVec, embedQuery('stripe billing invoice'));
  assert.ok(onTopic > offTopic);
  assert.ok(onTopic > 0.3, 'on-topic query is clearly similar');
});

test('buildEmbeddingIndex returns a stable id→vector map with backend metadata', () => {
  const items = [
    { id: 'a', title: 'Alpha', type: 'note', tags: ['x'], body: 'alpha body' },
    { id: 'b', title: 'Beta', type: 'note', tags: ['y'], body: 'beta body' },
    { id: null, title: 'skipme' }
  ];
  const index1 = buildEmbeddingIndex(items, { dimensions: 32 });
  const index2 = buildEmbeddingIndex(items, { dimensions: 32 });

  assert.equal(index1.backend, EMBEDDING_BACKEND);
  assert.equal(index1.dimensions, 32);
  assert.deepEqual(Object.keys(index1.embeddings).sort(), ['a', 'b'], 'idless items are skipped');
  assert.equal(index1.embeddings.a.length, 32);
  assert.deepEqual(index1, index2, 'index build is fully deterministic');
});
