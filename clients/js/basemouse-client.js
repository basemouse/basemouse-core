/** Lightweight ESM BaseMouse API client. No runtime dependencies. */
export class BaseMouseAPIError extends Error {
  constructor(message, { status, body, url } = {}) {
    super(message);
    this.name = 'BaseMouseAPIError';
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

export class BaseMouseClient {
  constructor({ baseUrl = process.env.BASEMOUSE_URL || 'https://basemouse.com', apiKey = process.env.BASEMOUSE_API_KEY || process.env.BASEMOUSE_TOKEN || '', fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    if (!fetchImpl) throw new Error('BaseMouseClient requires fetch (Node 18+ or a fetchImpl)');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(path, { method = 'GET', query, body, headers = {} } = {}) {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const reqHeaders = { Accept: 'application/json', ...headers };
    if (this.apiKey) reqHeaders.Authorization = `Bearer ${this.apiKey}`;
    if (body !== undefined) reqHeaders['Content-Type'] = 'application/json';
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: reqHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      const text = await res.text();
      // Parse defensively: a proxy/load-balancer 502/504 returns an HTML body,
      // so parse failures must still surface the real HTTP status below rather
      // than masquerade as a generic "Unexpected token" error with no status.
      let parsed = null;
      if (text) {
        try { parsed = JSON.parse(text); } catch { parsed = text; }
      }
      if (!res.ok) {
        throw new BaseMouseAPIError(parsed?.message || parsed?.error || `BaseMouse request failed with ${res.status}`, { status: res.status, body: parsed, url: String(url) });
      }
      return parsed;
    } catch (error) {
      if (error instanceof BaseMouseAPIError) throw error;
      throw new BaseMouseAPIError(error.name === 'AbortError' ? 'BaseMouse request timed out' : error.message, { url: String(url) });
    } finally {
      clearTimeout(timeout);
    }
  }

  // `retrieval` selects the ranking mode ('lexical' default, or 'hybrid' for
  // graph-aware expansion). `mode` is accepted as an alias. Omitting both keeps
  // the back-compatible lexical behavior.
  search({ q, type, tag, retrieval, mode } = {}) {
    return this.request('/api/search', { query: { q, type, tag, retrieval: retrieval ?? mode } });
  }

  contextPack({ q, limit, type, tag, workspace, retrieval, mode } = {}) {
    return this.request('/api/context-pack', { query: { q, limit, type, tag, workspace, retrieval: retrieval ?? mode } });
  }

  listRepository({ limit, offset } = {}) {
    return this.request('/api/repository', { query: { limit, offset } });
  }

  createDocument(document) {
    return this.request('/api/documents', { method: 'POST', body: document });
  }

  updateDocument(id, fields, { expectedVersion } = {}) {
    const body = expectedVersion === undefined ? fields : { ...fields, expectedVersion };
    return this.request(`/api/documents/${encodeURIComponent(id)}`, { method: 'PUT', body });
  }

  deleteDocument(id) {
    return this.request(`/api/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  documentHistory(id) {
    return this.request(`/api/documents/${encodeURIComponent(id)}/history`);
  }

  usage() {
    return this.request('/api/usage');
  }

  rotateKey() {
    return this.request('/api/keys/rotate', { method: 'POST' });
  }
}

export function formatContextPackForPrompt(pack) {
  const entries = pack?.entries || [];
  if (!entries.length) return 'BaseMouse context: no matching entries.';
  const lines = ['BaseMouse context (cite labels when used):'];
  for (const entry of entries) {
    const label = entry.citation?.label || `[${entry.id}] ${entry.title}`;
    const score = entry.relevance?.score ?? 'n/a';
    const checksum = entry.provenance?.checksum || 'n/a';
    lines.push(`\n${label}\nscore=${score}; checksum=${checksum}\n${entry.body || ''}`);
  }
  return lines.join('\n');
}

export default BaseMouseClient;
