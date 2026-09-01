// MCP OAuth 2.1 (RFC 8414 + RFC 9728 + PKCE S256) for Cursor one-click auth.
// Consent wraps an existing bm_ key. No IdP, magic-link, or email.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { generateKey, hashKey } from './auth.js';

const KEY_PATTERN = /^bm_[0-9a-f]{48}$/;
const CODE_TTL_MS = 5 * 60 * 1000;

export const CURSOR_REDIRECTS = Object.freeze([
  'https://www.cursor.com/agents/mcp/oauth/callback',
  'http://localhost:8787/callback',
  'http://127.0.0.1:8787/callback'
]);

export class OauthStore {
  constructor() {
    this.codes = new Map();
    this.clients = new Map();
  }

  registerClient({ redirectUris, clientName = 'mcp-client' }) {
    const clientId = `bmc_${randomBytes(16).toString('hex')}`;
    const record = {
      clientId,
      clientName,
      redirectUris: [...redirectUris],
      createdAt: Date.now()
    };
    this.clients.set(clientId, record);
    return record;
  }

  getClient(clientId) {
    return this.clients.get(clientId) || null;
  }

  putCode(record) {
    this.codes.set(record.codeHash, record);
  }

  takeCode(codeHash) {
    const record = this.codes.get(codeHash);
    if (!record) return null;
    this.codes.delete(codeHash);
    return record;
  }
}

export function issuerFromRequest(req) {
  const configured = String(process.env.APP_BASE_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  const host = String(req.headers.host || 'localhost').trim();
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const proto = forwarded === 'https' || forwarded === 'http'
    ? forwarded
    : (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https');
  return `${proto}://${host}`;
}

export function wwwAuthenticate(issuer) {
  return `Bearer realm="BaseMouse", resource_metadata="${issuer}/.well-known/oauth-protected-resource"`;
}

export function protectedResourceMetadata(issuer) {
  return {
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: ['basemouse'],
    resource_name: 'BaseMouse'
  };
}

export function authorizationServerMetadata(issuer) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['basemouse']
  };
}

export function s256(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function hashCode(code) {
  return createHash('sha256').update(code).digest('hex');
}

export function newCode() {
  return randomBytes(32).toString('base64url');
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function isAllowedRedirect(uri, client) {
  if (typeof uri !== 'string' || uri.length === 0) return false;
  if (CURSOR_REDIRECTS.includes(uri)) return true;
  return Boolean(client?.redirectUris?.includes(uri));
}

export function parseAuthorizeParams(src) {
  const responseType = String(src.response_type || '');
  const clientId = String(src.client_id || '');
  const redirectUri = String(src.redirect_uri || '');
  const state = src.state == null ? '' : String(src.state);
  const challenge = String(src.code_challenge || '');
  const method = String(src.code_challenge_method || '');
  const resource = src.resource == null ? '' : String(src.resource);
  return { responseType, clientId, redirectUri, state, challenge, method, resource };
}

export function validateAuthorizeParams(params, client) {
  if (params.responseType !== 'code') return 'response_type must be code';
  if (params.method !== 'S256') return 'code_challenge_method must be S256';
  if (!params.challenge || params.challenge.length < 43) return 'code_challenge is required';
  if (!isAllowedRedirect(params.redirectUri, client)) return 'redirect_uri is not allowed';
  return null;
}

export async function issueCode(oauth, { params, accessToken, demo }) {
  const code = newCode();
  oauth.putCode({
    codeHash: hashCode(code),
    challenge: params.challenge,
    redirectUri: params.redirectUri,
    clientId: params.clientId,
    accessToken,
    demo: Boolean(demo),
    expiresAt: Date.now() + CODE_TTL_MS
  });
  return code;
}

export async function exchangeCode(oauth, { code, verifier, redirectUri, clientId }) {
  if (!code || !verifier) return { error: 'invalid_request', message: 'code and code_verifier are required' };
  const record = oauth.takeCode(hashCode(code));
  if (!record || record.expiresAt < Date.now()) {
    return { error: 'invalid_grant', message: 'authorization code is unknown or expired' };
  }
  if (record.redirectUri !== redirectUri) {
    return { error: 'invalid_grant', message: 'redirect_uri does not match' };
  }
  if (record.clientId && clientId && record.clientId !== clientId) {
    return { error: 'invalid_grant', message: 'client_id does not match' };
  }
  if (!safeEqual(record.challenge, s256(verifier))) {
    return { error: 'invalid_grant', message: 'PKCE verification failed' };
  }
  return {
    access_token: record.accessToken,
    token_type: 'Bearer',
    expires_in: 86400 * 30,
    scope: 'basemouse'
  };
}

export async function resolveConsentKey(store, apiKey, { demo } = {}) {
  if (demo) {
    const plaintext = generateKey();
    await store.createKey({ plan: 'demo', keyHash: hashKey(plaintext) });
    return { ok: true, accessToken: plaintext };
  }
  const key = String(apiKey || '').trim();
  if (!KEY_PATTERN.test(key)) {
    return { ok: false, message: 'Paste a valid BaseMouse API key (bm_...).' };
  }
  const found = await store.findKeyByHash(hashKey(key));
  if (!found || found.status === 'revoked' || found.status === 'pending_claim' || found.status === 'system') {
    return { ok: false, message: 'That key is not valid. Check it and try again.' };
  }
  return { ok: true, accessToken: key };
}

export function redirectWithCode(redirectUri, code, state) {
  const url = new URL(redirectUri);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  return url.toString();
}

export function readFormBody(req, limit = 16 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        finish({ ok: false, status: 413, payload: { error: 'payload_too_large' } });
        chunks.length = 0;
        req.removeAllListeners('data');
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const value = {};
      for (const part of raw.split('&')) {
        if (!part) continue;
        const [k, v = ''] = part.split('=');
        value[decodeURIComponent(k.replace(/\+/g, ' '))] = decodeURIComponent(v.replace(/\+/g, ' '));
      }
      finish({ ok: true, value, raw });
    });
    req.on('error', () => finish({ ok: false, status: 400, payload: { error: 'bad_request' } }));
  });
}
