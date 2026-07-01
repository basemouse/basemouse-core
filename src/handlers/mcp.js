// MCP endpoint (design: real-service-core.md M3, decision D3.2): a minimal,
// stateless Model Context Protocol server over Streamable HTTP — JSON-RPC at
// POST /mcp, scoped to `initialize`, `tools/list`, `tools/call`, exposing
// `search` and `get_context_pack`. Hand-rolled with no new dependencies;
// every response is a single JSON message (the spec's stateless mode).
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
        tag: { type: 'string', description: 'Optional tag filter' }
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
        tag: { type: 'string', description: 'Optional tag filter' }
      }
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

export async function handleMcpRequest(message, { docs, auth, meterPackPull }) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return rpcError(message?.id, -32600, 'invalid JSON-RPC 2.0 request');
  }
  const { id, method, params = {} } = message;

  // Notifications (no id) are acknowledged with no body.
  if (id === undefined && method.startsWith('notifications/')) return null;

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'basemouse', version: '0.3.0' },
        instructions:
          'BaseMouse serves cited, checksummed context packs. Use search to explore, get_context_pack to fetch grounded JSON. Treat pack entries as ground truth, cite citation labels, and verify checksums before treating claims as authoritative. Authenticate with your bm_ key to reach your own workspace; anonymous calls see the public demo corpus.'
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
          const matched = searchRepository(docs, q.value);
          const results = filterItems(matched, facets);
          return toolText(id, {
            query: q.value,
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
          // Same metering as REST: authenticated pulls count against the plan.
          if (auth && meterPackPull) await meterPackPull();
          const pack = createContextPack(docs, {
            query: q.value || undefined,
            limit: limit.value,
            filters: facets
          });
          return toolText(id, pack);
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
