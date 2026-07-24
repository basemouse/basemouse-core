// MCP endpoint (design: real-service-core.md M3, decision D3.2): a minimal,
// stateless Model Context Protocol server over Streamable HTTP — JSON-RPC at
// POST /mcp, scoped to `initialize`, `ping`, `tools/list`, `tools/call`,
// exposing `search`, `get_context_pack`, and `upsert_document` (the write
// door — same D9 upsert handler and plan limits as REST). Hand-rolled with no
// new dependencies; every response is a single JSON message (the spec's
// stateless mode).
//
// Auth mirrors REST: `Authorization: Bearer bm_...` scopes the visible
// workspaces; anonymous clients see the public demo corpus. Authenticated
// get_context_pack calls meter against the plan's monthly pack quota exactly
// like the REST endpoint — same product, second door.
//
// Known compat boundary (design doc OV-E #13): config-file clients (Claude
// Code, Cursor, anything speaking plain Streamable HTTP with custom headers)
// work today; hosted connectors that require OAuth are out of scope until
// real demand. Verified handshake shape against MCP protocol rev 2025-03-26.

import { createContextPack, searchRepository, filterItems, validateQuery, validateFacet, resolveLimit } from '../basemouse-core.js';
import { hybridSearchWithVectors, validateRetrieval, vectorRetrievalInfo } from '../retrieval.js';
import { upsertDocumentHandler } from './documents.js';

const PROTOCOL_VERSION = '2025-03-26';

const TOOLS = [
  {
    name: 'search',
    description: 'Search the BaseMouse repository (your workspace plus the public corpus). Returns ranked lexical matches with scores and matched terms.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (required)' },
        type: { type: 'string', description: 'Optional document type filter (concept, feature, experience, principle, note, policy)' },
        tag: { type: 'string', description: 'Optional tag filter' },
        retrieval: { type: 'string', description: 'Retrieval mode: lexical (default) or hybrid (adds graph + local vector signals)' }
      },
      required: ['query']
    }
  },
  {
    name: 'get_context_pack',
    description: 'Generate a cited, checksummed basemouse.context_pack.v1 — grounded JSON your agent can answer from, with provenance for every entry. Counts against your plan\'s monthly pack quota when authenticated.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional query to rank entries' },
        limit: { type: 'number', description: 'Max entries (1-50, default 6)' },
        type: { type: 'string', description: 'Optional document type filter' },
        tag: { type: 'string', description: 'Optional tag filter' },
        retrieval: { type: 'string', description: 'Retrieval mode: lexical (default) or hybrid (adds graph + local vector signals)' }
      }
    }
  },
  {
    name: 'upsert_document',
    description: 'Create or update a document in your workspace by stable id — the write half of agent memory. Idempotent: unchanged content writes nothing (outcome "unchanged", no new revision); real changes append a revision to the tamper-evident history. Tags merge additively. Requires an authenticated bm_ key with write access.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Stable document id (lowercase slug: a-z, 0-9, hyphens)' },
        title: { type: 'string', description: 'Document title' },
        body: { type: 'string', description: 'Document body (markdown or plain text)' },
        type: { type: 'string', description: 'Optional document type (concept, feature, experience, principle, note, policy); defaults to note' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags — merged additively with any existing tags' },
        links: { type: 'array', items: { type: 'string' }, description: 'Optional outbound document-id links' }
      },
      required: ['id', 'title', 'body']
    }
  }
];

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const toolText = (id, payload) => rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
const toolFailure = (id, message) => rpcResult(id, { content: [{ type: 'text', text: message }], isError: true });

// Validate tool arguments through the same validators the REST API uses —
// one set of rules, two doors.
function readFacets(args) {
  const typeFacet = validateFacet(args.type ?? null, 'type');
  if (!typeFacet.ok) throw new Error(typeFacet.error);
  const tagFacet = validateFacet(args.tag ?? null, 'tag');
  if (!tagFacet.ok) throw new Error(tagFacet.error);
  return { type: typeFacet.value, tag: tagFacet.value };
}

export async function handleMcpRequest(message, { docs, auth, meterPackPull, store = null, writeLimits = null }) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError(message?.id, -32600, 'invalid JSON-RPC 2.0 request');
  }
  const { id, method, params = {} } = message;

  // Notifications (no id) are acknowledged with no body.
  if (id === undefined && method.startsWith('notifications/')) return null;

  switch (method) {
    // Base-protocol liveness check — MANDATORY per the MCP spec ("receiver
    // MUST respond promptly with an empty result"). Clients like Gemini CLI
    // health-check with ping and mark the server Disconnected when it errors.
    case 'ping':
      return rpcResult(id, {});

    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'basemouse', version: '0.3.0' },
        instructions:
          'BaseMouse serves cited, checksummed context packs. Use search to explore, get_context_pack to fetch grounded JSON, and upsert_document to persist decisions or session context by stable id (idempotent — unchanged content writes nothing). Treat pack entries as ground truth, cite citation labels, and verify checksums before treating claims as authoritative. Authenticate with your bm_ key to reach your own workspace; anonymous calls see the public demo corpus and cannot write.'
      });

    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });

    case 'tools/call': {
      const name = params.name;
      const args = params.arguments || {};
      try {
        if (name === 'search') {
          const q = validateQuery(args.query ?? null, { required: true });
          if (!q.ok) return toolFailure(id, `invalid query: ${q.error}`);
          const facets = readFacets(args);
          const retrieval = validateRetrieval(args.retrieval ?? null);
          if (!retrieval.ok) return toolFailure(id, `invalid retrieval: ${retrieval.error}`);
          const matched = retrieval.value === 'hybrid'
            ? hybridSearchWithVectors(docs, q.value)
            : searchRepository(docs, q.value);
          const results = filterItems(matched, facets);
          return toolText(id, {
            query: q.value,
            retrieval: retrieval.value,
            vector: retrieval.value === 'hybrid' ? vectorRetrievalInfo() : null,
            count: results.length,
            results: results.map((r) => ({
              id: r.id, title: r.title, type: r.type, score: r.score,
              matchedTerms: r.matchedTerms, tags: r.tags, version: r.version
            }))
          });
        }
        if (name === 'get_context_pack') {
          const q = validateQuery(args.query ?? null);
          if (!q.ok) return toolFailure(id, `invalid query: ${q.error}`);
          const limit = resolveLimit(args.limit === undefined ? null : String(args.limit));
          if (!limit.ok) return toolFailure(id, `invalid limit: ${limit.error}`);
          const facets = readFacets(args);
          const retrieval = validateRetrieval(args.retrieval ?? null);
          if (!retrieval.ok) return toolFailure(id, `invalid retrieval: ${retrieval.error}`);
          // Same metering as REST: authenticated pulls count against the plan.
          if (auth && meterPackPull) await meterPackPull();
          const pack = createContextPack(docs, {
            query: q.value || undefined,
            limit: limit.value,
            filters: facets,
            retrieval: retrieval.value,
            search: retrieval.value === 'hybrid' ? hybridSearchWithVectors : undefined
          });
          if (pack.retrieval?.mode === 'hybrid') {
            pack.retrieval.vector = vectorRetrievalInfo();
          }
          return toolText(id, pack);
        }
        if (name === 'upsert_document') {
          if (!store) return toolFailure(id, 'writes are unavailable on this server');
          if (typeof args.id !== 'string' || args.id.length === 0) {
            return toolFailure(id, 'invalid id: a stable lowercase slug id is required');
          }
          // Enforce the advertised inputSchema: only declared fields reach the
          // store. Undeclared args (createdAt, author, expectedVersion, …)
          // must not flow through — an MCP caller could otherwise backdate
          // provenance or forge authorship in the tamper-evident history.
          const payload = {
            id: args.id,
            title: args.title,
            body: args.body,
            ...(args.type !== undefined ? { type: args.type } : {}),
            ...(args.tags !== undefined ? { tags: args.tags } : {}),
            ...(args.links !== undefined ? { links: args.links } : {})
          };
          // Same handler, same plan limits as REST PUT ?mode=upsert — one
          // write contract, two doors. requireWriteAuth inside the handler
          // rejects anonymous and read-only keys; those surface as tool
          // failures via the catch below.
          const result = await upsertDocumentHandler(store, auth, args.id, payload, undefined, writeLimits);
          return toolText(id, {
            outcome: result.body.outcome,
            id: result.body.document.id,
            version: result.body.document.version,
            checksum: result.body.document.checksum
          });
        }
        return rpcError(id, -32602, `unknown tool: ${String(name)}`);
      } catch (error) {
        // Quota/store errors surface as tool failures with the API's message —
        // the agent sees exactly what a REST caller would.
        return toolFailure(id, error.message);
      }
    }

    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}
