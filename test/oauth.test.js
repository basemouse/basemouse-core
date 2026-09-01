import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createHash } from 'node:crypto';
import { createApp } from '../src/server.js';
import { MemoryStore } from '../src/memory-store.js';
import { createSeedRepository } from '../src/store.js';
import { hashKey, generateKey } from '../src/auth.js';
import { s256, CURSOR_REDIRECTS } from '../src/oauth.js';

const seeds = createSeedRepository();
const KEY = generateKey();
const verifier = 'a'.repeat(64);
const challenge = s256(verifier);
const redirect = CURSOR_REDIRECTS[1];

let server;
let base;
let store;

before(async () => {
  store = new MemoryStore(seeds);
  await store.createKey({ id: 'ws-oauth', plan: 'starter', keyHash: hashKey(KEY) });
  server = createApp(store, { seedCount: seeds.length });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const authorizeQuery = (extra = {}) => {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: 'cursor',
    redirect_uri: redirect,
    state: 'st1',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...extra
  });
  return `${base}/oauth/authorize?${q}`;
};

test('well-known protected resource metadata points at this issuer', async () => {
  const res = await fetch(`${base}/.well-known/oauth-protected-resource`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.resource, `${base}/mcp`);
  assert.deepEqual(body.authorization_servers, [base]);
  assert.ok(body.bearer_methods_supported.includes('header'));
});

test('path-aware protected resource metadata exists', async () => {
  const res = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.resource, `${base}/mcp`);
});

test('well-known authorization server advertises PKCE S256 and Cursor endpoints', async () => {
  const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.issuer, base);
  assert.equal(body.authorization_endpoint, `${base}/oauth/authorize`);
  assert.equal(body.token_endpoint, `${base}/oauth/token`);
  assert.equal(body.registration_endpoint, `${base}/oauth/register`);
  assert.deepEqual(body.code_challenge_methods_supported, ['S256']);
  assert.ok(body.grant_types_supported.includes('authorization_code'));
});

test('POST /mcp without Authorization is 401 with WWW-Authenticate resource_metadata', async () => {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  });
  assert.equal(res.status, 401);
  const www = res.headers.get('www-authenticate');
  assert.match(www, /resource_metadata=/);
  assert.match(www, /oauth-protected-resource/);
});

test('REST anonymous demo still works without a key', async () => {
  const res = await fetch(`${base}/api/repository?limit=1`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.count > 0);
});

test('GET /oauth/authorize with PKCE renders consent', async () => {
  const res = await fetch(authorizeQuery());
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Connect Cursor to BaseMouse/);
  assert.match(html, /name="api_key"/);
});

test('authorize rejects a missing PKCE challenge', async () => {
  const res = await fetch(authorizeQuery({ code_challenge: '', code_challenge_method: 'plain' }));
  assert.equal(res.status, 400);
});

test('authorize rejects an unknown redirect_uri', async () => {
  const res = await fetch(authorizeQuery({ redirect_uri: 'https://evil.example/callback' }));
  assert.equal(res.status, 400);
});

test('consent with a valid bm_ key redirects with a code; token returns that key', async () => {
  const body = new URLSearchParams({
    response_type: 'code',
    client_id: 'cursor',
    redirect_uri: redirect,
    state: 'st1',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    intent: 'key',
    api_key: KEY
  });
  const res = await fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'manual'
  });
  assert.equal(res.status, 302);
  const location = res.headers.get('location');
  assert.ok(location.startsWith(redirect));
  const url = new URL(location);
  assert.equal(url.searchParams.get('state'), 'st1');
  const code = url.searchParams.get('code');
  assert.ok(code);

  const tokenRes = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirect,
      client_id: 'cursor',
      code_verifier: verifier
    })
  });
  assert.equal(tokenRes.status, 200);
  const token = await tokenRes.json();
  assert.equal(token.token_type, 'Bearer');
  assert.equal(token.access_token, KEY);

  const mcp = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.access_token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  });
  assert.equal(mcp.status, 200);
});

test('consent with a bad key stays on the page', async () => {
  const body = new URLSearchParams({
    response_type: 'code',
    client_id: 'cursor',
    redirect_uri: redirect,
    state: 'st1',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    intent: 'key',
    api_key: 'bm_' + '0'.repeat(48)
  });
  const res = await fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /not valid|Paste a valid/i);
});

test('public demo consent mints a token MCP accepts', async () => {
  const body = new URLSearchParams({
    response_type: 'code',
    client_id: 'cursor',
    redirect_uri: redirect,
    state: 'demo',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    intent: 'demo'
  });
  const res = await fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'manual'
  });
  assert.equal(res.status, 302);
  const code = new URL(res.headers.get('location')).searchParams.get('code');
  const tokenRes = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirect,
      code_verifier: verifier
    })
  });
  const token = await tokenRes.json();
  assert.equal(tokenRes.status, 200);
  assert.match(token.access_token, /^bm_[0-9a-f]{48}$/);
  assert.notEqual(token.access_token, KEY);
});

test('token exchange requires PKCE verifier', async () => {
  const res = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', code: 'nope', redirect_uri: redirect })
  });
  assert.equal(res.status, 400);
});

test('DCR register returns a public client_id', async () => {
  const res = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Cursor',
      redirect_uris: ['http://localhost:8787/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code']
    })
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.match(body.client_id, /^bmc_/);
  assert.equal(body.token_endpoint_auth_method, 'none');
});

test('s256 helper matches Node base64url SHA-256', () => {
  const v = 'challenge-verifier-value-0123456789';
  const expected = createHash('sha256').update(v).digest('base64url');
  assert.equal(s256(v), expected);
});
