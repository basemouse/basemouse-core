import { createContextPack, searchRepository } from './basemouse-core.js';
import { hybridSearchWithVectors, validateRetrieval } from './retrieval.js';

const DEFAULT_LIMIT = 5;
const DEFAULT_MIN_RECALL = 1;

function ensureString(value, message) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(message);
  return value.trim();
}

function normalizeExpected(expected) {
  if (!Array.isArray(expected) || expected.length === 0) {
    throw new Error('expected must contain at least one document id');
  }
  const normalized = expected.map((id) => ensureString(id, 'expected document ids must be non-empty strings'));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('expected document ids must be unique');
  }
  return normalized;
}

function normalizeMinRecall(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('minRecall must be a number between 0 and 1');
  }
  return value;
}

function validateCase(caseDef) {
  if (!caseDef || typeof caseDef !== 'object') throw new Error('case must be an object');
  const id = ensureString(caseDef.id, 'case id is required');
  const query = ensureString(caseDef.query, `case ${id} query is required`);
  const expected = normalizeExpected(caseDef.expected);
  const limit = caseDef.limit === undefined ? DEFAULT_LIMIT : caseDef.limit;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('limit must be a positive integer');
  }
  return { id, query, expected, limit };
}

function normalizeRetrievalMode(retrieval) {
  const modeResult = validateRetrieval(retrieval, { fallback: 'hybrid' });
  if (!modeResult.ok) throw new Error(modeResult.error);
  return modeResult.value;
}

function idsFrom(results) {
  return results.map((item) => item.id).filter(Boolean);
}

function scoreIds(ids, expected) {
  const idSet = new Set(ids);
  const hits = expected.filter((id) => idSet.has(id));
  const missing = expected.filter((id) => !idSet.has(id));
  const firstHitRank = ids.findIndex((id) => expected.includes(id));
  return {
    ids,
    hits,
    missing,
    hitCount: hits.length,
    expectedCount: expected.length,
    recall: expected.length === 0 ? 0 : hits.length / expected.length,
    precision: ids.length === 0 ? 0 : hits.length / ids.length,
    mrr: firstHitRank === -1 ? 0 : 1 / (firstHitRank + 1)
  };
}

function searchFor(items, query, retrieval) {
  if (retrieval === 'hybrid') return hybridSearchWithVectors(items, query);
  return searchRepository(items, query);
}

export function evaluateRetrievalCase({
  items,
  caseDef,
  retrieval = 'hybrid',
  minRecall = DEFAULT_MIN_RECALL,
  generatedAt = new Date().toISOString()
}) {
  const normalized = validateCase(caseDef);
  const mode = normalizeRetrievalMode(retrieval);
  const recallThreshold = normalizeMinRecall(minRecall);

  const searchResults = searchFor(items, normalized.query, mode).slice(0, normalized.limit);
  const pack = createContextPack(items, {
    query: normalized.query,
    limit: normalized.limit,
    retrieval: mode,
    generatedAt,
    search: mode === 'hybrid' ? (repo, q) => hybridSearchWithVectors(repo, q) : undefined
  });

  const search = scoreIds(idsFrom(searchResults), normalized.expected);
  const contextPack = scoreIds(pack.entries.map((entry) => entry.id), normalized.expected);
  const pass = search.recall >= recallThreshold && contextPack.recall >= recallThreshold;

  return {
    id: normalized.id,
    query: normalized.query,
    retrieval: mode,
    limit: normalized.limit,
    expected: normalized.expected,
    expectedCount: normalized.expected.length,
    pass,
    search,
    contextPack
  };
}

export function evaluateRetrievalSuite({
  items,
  cases,
  retrieval = 'hybrid',
  minRecall = DEFAULT_MIN_RECALL,
  generatedAt = new Date().toISOString()
}) {
  if (!Array.isArray(items)) throw new Error('items must be an array');
  if (!Array.isArray(cases) || cases.length === 0) throw new Error('cases must contain at least one golden query');
  const mode = normalizeRetrievalMode(retrieval);
  const recallThreshold = normalizeMinRecall(minRecall);

  const evaluated = cases.map((caseDef) => evaluateRetrievalCase({
    items,
    caseDef,
    retrieval: mode,
    minRecall: recallThreshold,
    generatedAt
  }));
  const passed = evaluated.filter((entry) => entry.pass).length;
  const failed = evaluated.length - passed;
  const averageSearchRecall = evaluated.reduce((sum, entry) => sum + entry.search.recall, 0) / evaluated.length;
  const averageContextPackRecall = evaluated.reduce((sum, entry) => sum + entry.contextPack.recall, 0) / evaluated.length;
  const averageSearchMrr = evaluated.reduce((sum, entry) => sum + entry.search.mrr, 0) / evaluated.length;
  const averageContextPackMrr = evaluated.reduce((sum, entry) => sum + entry.contextPack.mrr, 0) / evaluated.length;

  return {
    pass: failed === 0,
    generatedAt,
    retrieval: mode,
    minRecall: recallThreshold,
    summary: {
      total: evaluated.length,
      passed,
      failed,
      averageSearchRecall,
      averageContextPackRecall,
      averageSearchMrr,
      averageContextPackMrr
    },
    cases: evaluated
  };
}

function pct(value) {
  return `${Math.round(value * 100)}%`;
}

export function formatRetrievalEvalReport(suite) {
  const status = suite.pass ? 'PASS' : 'FAIL';
  const lines = [
    `${status} retrieval eval: ${suite.summary.passed}/${suite.summary.total} cases passed`,
    `mode=${suite.retrieval} minRecall=${pct(suite.minRecall)} searchRecall=${pct(suite.summary.averageSearchRecall)} contextPackRecall=${pct(suite.summary.averageContextPackRecall)} searchMRR=${suite.summary.averageSearchMrr.toFixed(3)} contextPackMRR=${suite.summary.averageContextPackMrr.toFixed(3)}`
  ];
  for (const result of suite.cases) {
    const marker = result.pass ? '✓' : '✗';
    lines.push(`${marker} ${result.id}: search=${pct(result.search.recall)} context-pack=${pct(result.contextPack.recall)} query="${result.query}"`);
    if (!result.pass) {
      const missing = [...new Set([...result.search.missing, ...result.contextPack.missing])];
      lines.push(`  missing: ${missing.join(', ')}`);
      lines.push(`  search ids: ${result.search.ids.join(', ') || '(none)'}`);
      lines.push(`  context-pack ids: ${result.contextPack.ids.join(', ') || '(none)'}`);
    }
  }
  return lines.join('\n');
}
