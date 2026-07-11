// MCP endpoint tests (design doc test spec 5A): protocol conformance
// (initialize / tools/list / tools/call), malformed JSON-RPC, bearer-scoped
// vs anonymous corpus, quota metering parity with REST, and the notification
// path. Exercises the real HTTP surface, exactly as a config-file MCP client
// (Claude Code, Cursor) would speak to it.

import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createApp } from '../src/server.js';
import { MemoryStore } from '../src/memory-store.js';
import { createSeedRepository } from '../src/store.js';
import { hashKey, generateKey } from '../src/auth.js';

const seeds = createSeedRepository();
const KEY = generateKey();
const TINY_LIMITS = {
  demo: { maxDocuments: 100, packPullsPerMonth: 2, requestsPerMinute: 1000, maxStorageBytes: 10_000_000 },
  starter: { maxDocuments: 100, packPullsPerMonth: 2, requestsPerMinute: 1000, maxStorageBytes: 10_000_000 },
  team: { maxDocuments: 100, packPullsPerMonth: 2, requestsPerMinute: 1000, maxStorageBytes: 10_000_000 },
  enterprise: { maxDocuments: 100, packPullsPerMonth: 2, requestsPerMinute: 1000, maxStorageBytes: 10_000_000 }
};

let server;
let base;
let store;

before(async () => {
  store = new MemoryStore(seeds);
  await store.createKey({ id: 'ws-mcp', plan: 'demo', keyHash: hashKey(KEY) });
  await store.createDocument('ws-mcp', {
    id: 'private-runbook', title: 'Private Runbook', type: 'note', tags: ['private'],
    body: 'zebra-protocol failover steps', links: [], version: 1, author: 't',
    createdAt: '2026-06-11T00:00:00.000Z', updatedAt: '2026-06-11T00:00:00.000Z',
    checksum: 'x', source: { kind: 'api' }
  });
  server = createApp(store, { seedCount: seeds.length, planLimits: TINY_LIMITS });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const rpc = (payload, headers = {}) =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload)
  });

const authed = { Authorization: `Bearer ${KEY}` };

test('initialize: protocol version, tools capability, server identity, instructions', async () => {
  const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test' } } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.jsonrpc, '2.0');
  assert.equal(body.id, 1);
  assert.equal(body.result.protocolVersion, '2025-03-26');
  assert.ok(body.result.capabilities.tools);
  assert.equal(body.result.serverInfo.name, 'basemouse');
  assert.match(body.result.instructions, /checksums/);
});

test('notifications/initialized is acknowledged with 202 and no body', async () => {
  const res = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(res.status, 202);
});

test('ping returns an empty result (mandatory base-protocol utility; Gemini CLI health-checks with it)', async () => {
  const res = await rpc({ jsonrpc: '2.0', id: 42, method: 'ping' });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.id, 42);
  assert.deepEqual(body.result, {});
  assert.equal(body.error, undefined);
});

test('tools/list exposes search, get_context_pack, and upsert_document with input schemas', async () => {
  const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const body = await res.json();
  const names = body.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['get_context_pack', 'search', 'upsert_document']);
  const search = body.result.tools.find((t) => t.name === 'search');
  assert.deepEqual(search.inputSchema.required, ['query']);
  const upsert = body.result.tools.find((t) => t.name === 'upsert_document');
  assert.deepEqual(upsert.inputSchema.required, ['id', 'title', 'body']);
});

test('upsert_document: anonymous callers cannot write', async () => {
  const res = await rpc({
    jsonrpc: '2.0', id: 20, method: 'tools/call',
    params: { name: 'upsert_document', arguments: { id: 'agent-memo', title: 'Memo', body: 'hello' } }
  });
  const body = await res.json();
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /API key/);
});

test('upsert_document: create → unchanged → updated round trip with versioning', async () => {
  const call = (id, args) => rpc({
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'upsert_document', arguments: args }
  }, { Authorization: `Bearer ${KEY}` });

  const created = await (await call(21, { id: 'agent-memo', title: 'Memo', body: 'decision: ship it', tags: ['session'] })).json();
  assert.notEqual(created.result.isError, true);
  const c = JSON.parse(created.result.content[0].text);
  assert.equal(c.outcome, 'created');
  assert.equal(c.version, 1);

  // Same content again — no new revision, even with trailing whitespace
  // (server-side trim owns the comparison now, not the client).
  const same = await (await call(22, { id: 'agent-memo', title: ' Memo ', body: 'decision: ship it\n', tags: ['session'] })).json();
  const s = JSON.parse(same.result.content[0].text);
  assert.equal(s.outcome, 'unchanged');
  assert.equal(s.version, 1);

  // Changed body bumps the version; tags merge additively.
  const changed = await (await call(23, { id: 'agent-memo', title: 'Memo', body: 'decision: ship it, then verify', tags: ['verified'] })).json();
  const u = JSON.parse(changed.result.content[0].text);
  assert.equal(u.outcome, 'updated');
  assert.equal(u.version, 2);
  const doc = await store.getDocument(['ws-mcp'], 'agent-memo');
  assert.deepEqual(doc.tags, ['session', 'verified']);
});

test('tools/call search: anonymous sees only the public corpus', async () => {
  const res = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search', arguments: { query: 'zebra-protocol failover' } } });
  const body = await res.json();
  const payload = JSON.parse(body.result.content[0].text);
  assert.ok(!payload.results.some((r) => r.id === 'private-runbook'), 'private docs never leak to anonymous MCP clients');
});

test('tools/call search: bearer key reaches its own workspace', async () => {
  const res = await rpc(
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'search', arguments: { query: 'zebra-protocol failover' } } },
    authed
  );
  const body = await res.json();
  const payload = JSON.parse(body.result.content[0].text);
  assert.ok(payload.results.some((r) => r.id === 'private-runbook'));
});

test('tools/call search supports retrieval=hybrid, matching REST feature parity', async () => {
  const res = await rpc(
    { jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'search', arguments: { query: 'memory', retrieval: 'hybrid' } } },
    authed
  );
  const body = await res.json();
  const payload = JSON.parse(body.result.content[0].text);
  assert.equal(payload.retrieval, 'hybrid');
  assert.equal(payload.vector?.backend, 'local-hashed');
  assert.ok(payload.results.every((r) => r.id), 'hybrid results still shape normally');
});

// Uses the anonymous corpus (not the authed key) so this doesn't interfere
// with the packPullsPerMonth boundary test below.
test('tools/call get_context_pack supports retrieval=hybrid, matching REST feature parity', async () => {
  const res = await rpc({
    jsonrpc: '2.0', id: 21, method: 'tools/call',
    params: { name: 'get_context_pack', arguments: { query: 'memory', retrieval: 'hybrid', limit: 10 } }
  });
  const body = await res.json();
  const pack = JSON.parse(body.result.content[0].text);
  assert.equal(pack.retrieval.mode, 'hybrid');
  assert.equal(pack.retrieval.vector?.backend, 'local-hashed');
});

test('tools/call rejects an invalid retrieval value on both tools', async () => {
  const badSearch = await rpc({ jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'search', arguments: { query: 'agent', retrieval: 'semantic' } } });
  const searchBody = await badSearch.json();
  assert.equal(searchBody.result.isError, true);
  assert.match(searchBody.result.content[0].text, /retrieval/);

  const badPack = await rpc({ jsonrpc: '2.0', id: 23, method: 'tools/call', params: { name: 'get_context_pack', arguments: { retrieval: 'semantic' } } });
  const packBody = await badPack.json();
  assert.equal(packBody.result.isError, true);
  assert.match(packBody.result.content[0].text, /retrieval/);
});

test('tools/call get_context_pack returns a valid pack and meters the quota', async () => {
  const call = () => rpc(
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_context_pack', arguments: { query: 'agent context', limit: 2 } } },
    authed
  );
  const first = await (await call()).json();
  const pack = JSON.parse(first.result.content[0].text);
  assert.equal(pack.schema, 'basemouse.context_pack.v1');
  assert.ok(pack.entries.length > 0);
  assert.ok(pack.entries[0].provenance.checksum);

  await call(); // second pull — quota (2/month in TINY_LIMITS) now exhausted
  const third = await (await call()).json();
  assert.equal(third.result.isError, true, 'quota exhaustion surfaces as a tool failure');
  assert.match(third.result.content[0].text, /quota/);
});

test('anonymous get_context_pack is not metered (demo corpus, IP-limited instead)', async () => {
  for (let i = 0; i < 3; i++) {
    const res = await rpc({ jsonrpc: '2.0', id: 10 + i, method: 'tools/call', params: { name: 'get_context_pack', arguments: { limit: 1 } } });
    const body = await res.json();
    assert.ok(!body.result.isError, `anonymous pull ${i + 1} works`);
  }
});

test('malformed JSON-RPC and unknown methods return proper error objects', async () => {
  const notRpc = await (await rpc({ hello: 'world' })).json();
  assert.equal(notRpc.error.code, -32600);

  const unknownMethod = await (await rpc({ jsonrpc: '2.0', id: 6, method: 'resources/list' })).json();
  assert.equal(unknownMethod.error.code, -32601);

  const unknownTool = await (await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'drop_tables' } })).json();
  assert.equal(unknownTool.error.code, -32602);

  const badArgs = await (await rpc({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'search', arguments: {} } })).json();
  assert.equal(badArgs.result.isError, true);
});

test('GET /mcp is 405 (stateless: no SSE stream)', async () => {
  const res = await fetch(`${base}/mcp`);
  assert.equal(res.status, 405);
});

test('invalid bearer on /mcp is rejected like REST', async () => {
  const res = await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/list' }, { Authorization: 'Bearer not-a-key' });
  assert.equal(res.status, 401);
});

test('upsert_document: read-only (cancelled) keys cannot write', async () => {
  const RO_KEY = generateKey();
  const created = await store.createKey({ id: 'ws-ro', plan: 'demo', keyHash: hashKey(RO_KEY) });
  store.keys.get(created.id).status = 'read_only';
  const res = await rpc({
    jsonrpc: '2.0', id: 30, method: 'tools/call',
    params: { name: 'upsert_document', arguments: { id: 'ro-memo', title: 'T', body: 'b' } }
  }, { Authorization: `Bearer ${RO_KEY}` });
  const body = await res.json();
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /read.?only/i);
});

test('upsert_document: undeclared args (createdAt/author) never reach the store', async () => {
  const res = await rpc({
    jsonrpc: '2.0', id: 31, method: 'tools/call',
    params: {
      name: 'upsert_document',
      arguments: {
        id: 'forge-memo', title: 'Memo', body: 'content',
        createdAt: '2020-01-01T00:00:00.000Z', author: 'forged-ceo', expectedVersion: 9
      }
    }
  }, { Authorization: `Bearer ${KEY}` });
  const body = await res.json();
  assert.notEqual(body.result.isError, true);
  const doc = await store.getDocument(['ws-mcp'], 'forge-memo');
  assert.equal(doc.author, null, 'author is not in the tool schema and must not flow through');
  assert.notEqual(doc.createdAt, '2020-01-01T00:00:00.000Z', 'provenance timestamps cannot be backdated over MCP');
});

test('upsert_document: bodies far beyond the old 4KB /mcp cap are accepted (256KB parity with REST)', async () => {
  const res = await rpc({
    jsonrpc: '2.0', id: 32, method: 'tools/call',
    params: { name: 'upsert_document', arguments: { id: 'big-memo', title: 'Big', body: 'y'.repeat(64 * 1024) } }
  }, { Authorization: `Bearer ${KEY}` });
  assert.equal(res.status, 200, 'must not be rejected 413 by the JSON-RPC envelope cap');
  const body = await res.json();
  assert.notEqual(body.result.isError, true);
  const payload = JSON.parse(body.result.content[0].text);
  assert.equal(payload.outcome, 'created');
});
