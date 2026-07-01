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

test('tools/list exposes search and get_context_pack with input schemas', async () => {
  const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const body = await res.json();
  const names = body.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['get_context_pack', 'search']);
  const search = body.result.tools.find((t) => t.name === 'search');
  assert.deepEqual(search.inputSchema.required, ['query']);
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
