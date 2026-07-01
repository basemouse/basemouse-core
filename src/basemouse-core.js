// Pure, dependency-free knowledge primitives for BaseMouse.
// This module never touches the filesystem or network so it stays trivially
// testable. Durable loading and provenance live in src/store.js.

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is',
  'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'with', 'your'
]);

export const CONTEXT_PACK_SCHEMA = 'basemouse.context_pack.v1';
export const MAX_QUERY_LENGTH = 256;
export const DEFAULT_LIMIT = 6;
export const MAX_LIMIT = 50;

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function haystackFor(item) {
  return tokenize([
    item.title,
    item.type,
    ...(item.tags || []),
    item.body
  ].join(' '));
}

// Returns matches with a relevance score and the query terms that actually hit,
// so the context pack can explain *why* an entry was retrieved.
export function searchRepository(items, query) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  return items
    .map((item) => {
      const haystack = haystackFor(item);
      const matchedTerms = [];
      let score = 0;
      for (const token of queryTokens) {
        const hits = haystack.filter((word) => word.includes(token) || token.includes(word)).length;
        if (hits > 0) {
          score += hits;
          matchedTerms.push(token);
        }
      }
      return { ...item, score, matchedTerms };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

// --- Hybrid / GraphRAG retrieval ---------------------------------------------
//
// Optional, off-by-default retrieval that augments the lexical scorer with two
// extra signals while staying pure and dependency-free:
//   - lexical: the existing token score (searchRepository), the baseline seed.
//   - vector:  caller-supplied similarity — either an { id: score } map, an
//              embeddings map + queryVector (cosine, computed here), or a hook.
//              No embedding provider/network lives in this module.
//   - graph:   one-hop expansion from lexical/vector seeds to their linked docs,
//              at a decayed score, so a related doc that never matched the query
//              can still surface — with provenance explaining why.
// searchRepository() and createContextPack() defaults are untouched; hybrid only
// runs when you call hybridSearchRepository() or pass createContextPack a
// `retrieval` option.

export const DEFAULT_RETRIEVAL_WEIGHTS = { lexical: 1, vector: 1, graph: 0.5 };
const DEFAULT_GRAPH_DECAY = 0.5;

// Cosine similarity of two equal-length numeric vectors. Returns 0 for
// mismatched lengths or a zero-magnitude vector — pure, no allocation beyond locals.
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Resolve the vector signal into an { id -> rawScore } Map. Precedence:
// explicit vectorScores (object or function), then embeddings + queryVector.
function resolveVectorScores(items, query, options) {
  const out = new Map();
  const supplied = options.vectorScores;

  if (typeof supplied === 'function') {
    for (const item of items) {
      const value = supplied(item, query);
      if (typeof value === 'number' && value > 0) out.set(item.id, value);
    }
    return out;
  }
  if (supplied && typeof supplied === 'object') {
    for (const item of items) {
      const value = supplied[item.id];
      if (typeof value === 'number' && value > 0) out.set(item.id, value);
    }
    return out;
  }
  if (options.embeddings && typeof options.embeddings === 'object' && Array.isArray(options.queryVector)) {
    for (const item of items) {
      const vector = options.embeddings[item.id];
      if (!Array.isArray(vector)) continue;
      const sim = cosineSimilarity(vector, options.queryVector);
      if (sim > 0) out.set(item.id, sim);
    }
  }
  return out;
}

// Hybrid retrieval over `items`. Returns items with a combined `score`, the
// lexical `matchedTerms`, and a `retrieval` provenance object
// ({ mode, signals, reasons, sourceScores }). Deterministic ordering and no deps.
export function hybridSearchRepository(items, query, options = {}) {
  const weights = { ...DEFAULT_RETRIEVAL_WEIGHTS, ...(options.weights || {}) };
  const graphOpt = options.graph;
  const graphEnabled = graphOpt === true
    || (graphOpt !== null && typeof graphOpt === 'object' && graphOpt.enabled !== false);
  const graphDecay = (graphOpt && typeof graphOpt === 'object' && typeof graphOpt.decay === 'number')
    ? graphOpt.decay
    : DEFAULT_GRAPH_DECAY;

  const lexicalById = new Map(searchRepository(items, query).map((hit) => [hit.id, hit]));
  const vectorById = resolveVectorScores(items, query, options);

  // Accumulator keyed by id; nodes are created lazily for items with any signal.
  const nodes = new Map();
  const ensure = (item) => {
    let node = nodes.get(item.id);
    if (!node) {
      node = { item, lexical: 0, vector: 0, graph: 0, graphSeed: null, matchedTerms: [], reasons: [] };
      nodes.set(item.id, node);
    }
    return node;
  };

  for (const item of items) {
    const lex = lexicalById.get(item.id);
    const vec = vectorById.get(item.id) || 0;
    const hasLex = lex && lex.score > 0;
    const hasVec = vec > 0;
    if (!hasLex && !hasVec) continue;
    const node = ensure(item);
    if (hasLex) {
      node.lexical = weights.lexical * lex.score;
      node.matchedTerms = lex.matchedTerms;
      node.reasons.push(`lexical match on ${lex.matchedTerms.map((t) => `"${t}"`).join(', ')}`);
    }
    if (hasVec) {
      node.vector = weights.vector * vec;
      node.reasons.push(`vector similarity ${vec.toFixed(3)}`);
    }
  }

  if (graphEnabled) {
    const byId = new Map(items.map((item) => [item.id, item]));
    // Snapshot seeds (lexical/vector) before expanding so this is strictly one hop.
    const seeds = [...nodes.values()]
      .map((node) => ({ id: node.item.id, base: node.lexical + node.vector }))
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const seed of seeds) {
      const links = Array.isArray(byId.get(seed.id).links) ? byId.get(seed.id).links : [];
      for (const targetId of links) {
        const target = byId.get(targetId);
        if (!target) continue; // dangling link → nothing to expand to
        const contribution = weights.graph * graphDecay * seed.base;
        if (contribution <= 0) continue;
        const node = ensure(target);
        if (contribution > node.graph) {
          node.graph = contribution;
          node.graphSeed = seed.id; // strongest seed wins the explanation
        }
      }
    }
    for (const node of nodes.values()) {
      if (node.graph > 0) node.reasons.push(`graph neighbor of ${node.graphSeed}`);
    }
  }

  const results = [...nodes.values()].map((node) => {
    const sourceScores = {};
    const signals = [];
    if (node.lexical > 0) { sourceScores.lexical = node.lexical; signals.push('lexical'); }
    if (node.vector > 0) { sourceScores.vector = node.vector; signals.push('vector'); }
    if (node.graph > 0) { sourceScores.graph = node.graph; signals.push('graph'); }
    return {
      ...node.item,
      score: node.lexical + node.vector + node.graph,
      matchedTerms: node.matchedTerms,
      retrieval: { mode: 'hybrid', signals, reasons: node.reasons, sourceScores }
    };
  });

  results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  return results;
}

// Clamp/validate a caller-supplied limit. Returns { ok, value } or { ok:false, error }.
export function resolveLimit(raw, { fallback = DEFAULT_LIMIT, max = MAX_LIMIT } = {}) {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: fallback };
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    return { ok: false, error: 'limit must be a positive integer' };
  }
  return { ok: true, value: Math.min(value, max) };
}

// Validate/normalize a facet filter value (type or tag). Returns { ok, value }
// where an empty string means "no filter", or { ok:false, error } when too long.
export function validateFacet(raw, label = 'filter') {
  const value = String(raw ?? '').trim();
  if (value.length > MAX_QUERY_LENGTH) {
    return { ok: false, error: `${label} must be <= ${MAX_QUERY_LENGTH} characters` };
  }
  return { ok: true, value };
}

// Narrow items by an optional type and/or tag. Empty/undefined filter fields are
// no-ops. Matching is case-insensitive. Pure — never mutates the input.
export function filterItems(items, { type, tag } = {}) {
  const typeNeedle = typeof type === 'string' ? type.trim().toLowerCase() : '';
  const tagNeedle = typeof tag === 'string' ? tag.trim().toLowerCase() : '';
  if (!typeNeedle && !tagNeedle) return items.slice();
  return items.filter((item) => {
    if (typeNeedle && String(item.type || '').toLowerCase() !== typeNeedle) return false;
    if (tagNeedle) {
      const tags = Array.isArray(item.tags) ? item.tags : [];
      if (!tags.some((t) => String(t).toLowerCase() === tagNeedle)) return false;
    }
    return true;
  });
}

// Validate/normalize a search query string. Returns { ok, value } or { ok:false, error }.
export function validateQuery(raw, { required = false } = {}) {
  const value = String(raw ?? '').trim();
  if (value.length === 0 && required) {
    return { ok: false, error: 'query is required' };
  }
  if (value.length > MAX_QUERY_LENGTH) {
    return { ok: false, error: `query must be <= ${MAX_QUERY_LENGTH} characters` };
  }
  return { ok: true, value };
}

function provenanceOf(item) {
  return {
    source: item.source || { kind: 'unknown' },
    checksum: item.checksum || null,
    version: item.version ?? null,
    author: item.author || null,
    createdAt: item.createdAt || null,
    updatedAt: item.updatedAt || null
  };
}

// Per-entry retrieval provenance. Hybrid results already carry a `retrieval`
// object; lexical/no-query entries get a synthesized lexical one so every entry
// has the same shape regardless of mode.
function retrievalOf(item) {
  if (item.retrieval) return item.retrieval;
  const score = typeof item.score === 'number' ? item.score : null;
  if (score && score > 0) {
    const matched = item.matchedTerms || [];
    return {
      mode: 'lexical',
      signals: ['lexical'],
      reasons: [`lexical match on ${matched.map((t) => `"${t}"`).join(', ')}`],
      sourceScores: { lexical: score }
    };
  }
  return { mode: 'lexical', signals: [], reasons: [], sourceScores: {} };
}

function citationOf(item) {
  const version = item.version ? ` v${item.version}` : '';
  return {
    id: item.id,
    title: item.title,
    label: `[${item.id}] ${item.title}${version}`,
    checksum: item.checksum || null,
    source: item.source?.path || item.source?.kind || null
  };
}

// Build an agent-ready, citation-bearing context pack from repository items.
export function createContextPack(items, options = {}) {
  const query = options.query ? String(options.query) : null;
  const limitResult = resolveLimit(options.limit);
  const limit = limitResult.ok ? limitResult.value : DEFAULT_LIMIT;

  const rawFilters = options.filters || {};
  const typeFilter = typeof rawFilters.type === 'string' && rawFilters.type.trim()
    ? rawFilters.type.trim()
    : null;
  const tagFilter = typeof rawFilters.tag === 'string' && rawFilters.tag.trim()
    ? rawFilters.tag.trim()
    : null;

  // Hybrid retrieval is opt-in. Accept both the pure-core object form
  // (`retrieval: { graph: true, ... }`) and the API-facing string form
  // (`retrieval: 'hybrid'`) used by server/client wiring. A custom search
  // function can still be injected by tests/adapters; otherwise this module uses
  // its own pure hybridSearchRepository implementation.
  const retrievalMode = options.retrieval === 'hybrid'
    || (options.retrieval && typeof options.retrieval === 'object')
    ? 'hybrid'
    : 'lexical';
  const retrievalOpt = options.retrieval && typeof options.retrieval === 'object'
    ? options.retrieval
    : (retrievalMode === 'hybrid' ? { graph: true } : null);
  const hybridEnabled = retrievalMode === 'hybrid' && !!query;
  const search = typeof options.search === 'function'
    ? options.search
    : (hybridEnabled ? (repo, q) => hybridSearchRepository(repo, q, retrievalOpt) : searchRepository);
  const matched = query ? search(items, query) : items;
  // Filter composes with search: narrow the candidate set, preserving rank/order.
  const selected = filterItems(matched, { type: typeFilter, tag: tagFilter });
  const sliced = selected.slice(0, limit);

  // Lookups against the FULL repository so links resolve even to docs not in
  // this pack, and so we can flag which linked docs are present in the pack.
  const byId = new Map(items.map((item) => [item.id, item]));
  const inPackIds = new Set(sliced.map((item) => item.id));

  const entries = sliced.map((item) => {
    const links = Array.isArray(item.links) ? item.links : [];
    const related = links.map((linkId) => {
      const target = byId.get(linkId);
      return {
        id: linkId,
        title: target ? target.title : null,
        inPack: inPackIds.has(linkId)
      };
    });
    return {
      id: item.id,
      title: item.title,
      type: item.type,
      tags: item.tags || [],
      body: item.body,
      links,
      updatedAt: item.updatedAt || null,
      version: item.version ?? null,
      relevance: {
        score: typeof item.score === 'number' ? item.score : null,
        matchedTerms: item.matchedTerms || []
      },
      retrieval: retrievalOf(item),
      related,
      citation: citationOf(item),
      provenance: provenanceOf(item)
    };
  });

  // Deduplicated, deterministic outbound-edge list across all entries.
  const seenEdges = new Set();
  const relationships = [];
  for (const entry of entries) {
    for (const to of entry.links) {
      const key = `${entry.id} ${to}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      relationships.push({ from: entry.id, to, resolved: byId.has(to) });
    }
  }
  relationships.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  // Pack-level retrieval summary: the mode and the union of signals that
  // actually contributed across entries, plus the weights when hybrid ran.
  const packSignals = [...new Set(entries.flatMap((entry) => entry.retrieval.signals))].sort();
  const packRetrieval = {
    mode: hybridEnabled ? 'hybrid' : 'lexical',
    signals: packSignals,
    weights: hybridEnabled
      ? { ...DEFAULT_RETRIEVAL_WEIGHTS, ...(retrievalOpt.weights || {}) }
      : null
  };

  return {
    schema: CONTEXT_PACK_SCHEMA,
    generatedAt: options.generatedAt || new Date().toISOString(),
    query,
    retrieval: packRetrieval,
    filters: { type: typeFilter, tag: tagFilter },
    entryCount: entries.length,
    totalMatches: selected.length,
    truncated: selected.length > entries.length,
    citations: entries.map((entry) => entry.citation),
    entries,
    relationships,
    agentInstructions: [
      'Use entries as grounded BaseMouse project context.',
      'Cite supporting facts using the citation.label or entry id.',
      'Prefer entries with higher relevance.score and more recent provenance.updatedAt.',
      'Verify claims against provenance.checksum before treating them as authoritative.',
      'Use relationships and entry.related to see how documents connect; follow them to guide further retrieval.',
      'If the task needs missing context, ask for a repository search or a larger context pack.'
    ]
  };
}
