import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateRetrievalCase,
  evaluateRetrievalSuite,
  formatRetrievalEvalReport
} from '../src/retrieval-eval.js';

const corpus = [
  {
    id: 'security-policy',
    title: 'Security Policy',
    type: 'policy',
    tags: ['security'],
    body: 'Rotate API keys every quarter. Keep bearer tokens out of logs.',
    checksum: 'sec',
    version: 1
  },
  {
    id: 'billing-runbook',
    title: 'Billing Runbook',
    type: 'runbook',
    tags: ['billing', 'stripe'],
    body: 'Stripe checkout issues a key through the claim page. Cancellation makes keys read only.',
    checksum: 'bill',
    version: 1
  },
  {
    id: 'retrieval-design',
    title: 'Retrieval Design',
    type: 'spec',
    tags: ['retrieval'],
    body: 'Hybrid search combines lexical matches, local vector similarity, and one hop graph expansion.',
    links: ['security-policy'],
    checksum: 'ret',
    version: 1
  }
];

test('evaluateRetrievalCase scores expected docs for search and context-pack results', () => {
  const result = evaluateRetrievalCase({
    items: corpus,
    caseDef: {
      id: 'stripe-claim',
      query: 'how does stripe checkout create a key?',
      expected: ['billing-runbook'],
      limit: 2
    },
    retrieval: 'hybrid',
    generatedAt: '2026-06-26T00:00:00.000Z'
  });

  assert.equal(result.id, 'stripe-claim');
  assert.equal(result.query, 'how does stripe checkout create a key?');
  assert.equal(result.pass, true);
  assert.equal(result.expectedCount, 1);
  assert.deepEqual(result.search.ids.slice(0, 1), ['billing-runbook']);
  assert.deepEqual(result.contextPack.ids.slice(0, 1), ['billing-runbook']);
  assert.equal(result.search.recall, 1);
  assert.equal(result.contextPack.recall, 1);
  assert.equal(result.search.mrr, 1);
  assert.equal(result.contextPack.mrr, 1);
});

test('evaluateRetrievalSuite aggregates pass/fail metrics and identifies misses', () => {
  const suite = evaluateRetrievalSuite({
    items: corpus,
    cases: [
      { id: 'security', query: 'bearer token logs', expected: ['security-policy'], limit: 2 },
      { id: 'missing', query: 'customer support playbook', expected: ['billing-runbook'], limit: 1 }
    ],
    retrieval: 'lexical',
    minRecall: 1,
    generatedAt: '2026-06-26T00:00:00.000Z'
  });

  assert.equal(suite.summary.total, 2);
  assert.equal(suite.summary.passed, 1);
  assert.equal(suite.summary.failed, 1);
  assert.equal(suite.pass, false);
  assert.equal(suite.cases[1].pass, false);
  assert.deepEqual(suite.cases[1].search.missing, ['billing-runbook']);
  assert.match(formatRetrievalEvalReport(suite), /FAIL retrieval eval: 1\/2 cases passed/);
  assert.match(formatRetrievalEvalReport(suite), /missing/);
});

test('evaluateRetrievalSuite rejects malformed golden cases before scoring', () => {
  assert.throws(
    () => evaluateRetrievalSuite({ items: corpus, cases: [{ query: 'no id', expected: ['security-policy'] }] }),
    /case id is required/
  );
  assert.throws(
    () => evaluateRetrievalSuite({ items: corpus, cases: [{ id: 'bad', query: 'x', expected: [] }] }),
    /expected must contain at least one document id/
  );
  assert.throws(
    () => evaluateRetrievalSuite({ items: corpus, cases: [{ id: 'bad-limit', query: 'x', expected: ['security-policy'], limit: 0 }] }),
    /limit must be a positive integer/
  );
  assert.throws(
    () => evaluateRetrievalSuite({ items: corpus, cases: [{ id: 'dupe-expected', query: 'x', expected: ['security-policy', 'security-policy'] }] }),
    /expected document ids must be unique/
  );
  assert.throws(
    () => evaluateRetrievalSuite({ items: corpus, cases: [{ id: 'bad-recall', query: 'x', expected: ['security-policy'] }], minRecall: 1.5 }),
    /minRecall must be a number between 0 and 1/
  );
});

test('evaluateRetrievalSuite normalizes suite-level retrieval mode', () => {
  const suite = evaluateRetrievalSuite({
    items: corpus,
    cases: [{ id: 'security', query: 'bearer token logs', expected: ['security-policy'], limit: 2 }],
    retrieval: 'HYBRID',
    generatedAt: '2026-06-26T00:00:00.000Z'
  });

  assert.equal(suite.retrieval, 'hybrid');
  assert.equal(suite.cases[0].retrieval, 'hybrid');
});
