import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BaseMouseClient, BaseMouseAPIError, formatContextPackForPrompt } from '../clients/js/basemouse-client.js';

test('JS client builds context-pack requests and formats prompt context', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ entries: [{ id: 'a', title: 'Alpha', body: 'Body', citation: { label: '[a] Alpha' }, relevance: { score: 3 }, provenance: { checksum: 'abc' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = new BaseMouseClient({ baseUrl: 'https://example.test', apiKey: 'bm_test', fetchImpl });
  const pack = await client.contextPack({ q: 'agent context', limit: 2, workspace: 'alpha' });
  assert.equal(new URL(calls[0].url).pathname, '/api/context-pack');
  assert.equal(new URL(calls[0].url).searchParams.get('workspace'), 'alpha');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer bm_test');
  assert.match(formatContextPackForPrompt(pack), /\[a\] Alpha/);
});

test('JS client forwards retrieval mode on search and contextPack', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ retrieval: 'hybrid', results: [], entries: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = new BaseMouseClient({ baseUrl: 'https://example.test', fetchImpl });

  await client.search({ q: 'memory', retrieval: 'hybrid' });
  assert.equal(new URL(calls[0]).searchParams.get('retrieval'), 'hybrid');

  await client.contextPack({ q: 'memory', retrieval: 'hybrid' });
  assert.equal(new URL(calls[1]).searchParams.get('retrieval'), 'hybrid');

  // `mode` is accepted as an alias for `retrieval`.
  await client.search({ q: 'memory', mode: 'hybrid' });
  assert.equal(new URL(calls[2]).searchParams.get('retrieval'), 'hybrid');
});

test('JS client omits retrieval when not requested (back-compatible)', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = new BaseMouseClient({ baseUrl: 'https://example.test', fetchImpl });
  await client.search({ q: 'memory' });
  assert.equal(new URL(calls[0]).searchParams.has('retrieval'), false);
});

test('JS client raises BaseMouseAPIError for non-2xx responses', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: 'unauthorized', message: 'missing key' }), { status: 401 });
  const client = new BaseMouseClient({ baseUrl: 'https://example.test', fetchImpl });
  await assert.rejects(() => client.usage(), (err) => err instanceof BaseMouseAPIError && err.status === 401);
});

test('JS client preserves HTTP status when an error body is non-JSON (e.g. a proxy 502)', async () => {
  const fetchImpl = async () => new Response('<html>502 Bad Gateway</html>', { status: 502 });
  const client = new BaseMouseClient({ baseUrl: 'https://example.test', fetchImpl });
  await assert.rejects(() => client.usage(), (err) => err instanceof BaseMouseAPIError && err.status === 502 && /502/.test(err.message));
});
