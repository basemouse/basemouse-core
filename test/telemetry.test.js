import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/server.js';
import { createSeedRepository } from '../src/store.js';
import { createContextPack } from '../src/basemouse-core.js';
import { buildContextPackPayload, createTelemetry, loadTelemetryConfig, tracesUrlFor } from '../src/telemetry.js';

const ENABLED_ENV = {
  MESHAI_OTLP_ENDPOINT: 'https://api.meshai.dev/api/v1/ingest',
  MESHAI_API_KEY: 'msh_test_key'
};

function findAttr(attrs, key) {
  return attrs.find((a) => a.key === key);
}

function samplePack() {
  return createContextPack(createSeedRepository(), { query: 'agent context', limit: 3 });
}

test('tracesUrlFor appends /v1/traces, respects an explicit path, rejects non-http', () => {
  assert.equal(tracesUrlFor('https://api.meshai.dev/api/v1/ingest'), 'https://api.meshai.dev/api/v1/ingest/v1/traces');
  assert.equal(tracesUrlFor('https://api.meshai.dev/api/v1/ingest/'), 'https://api.meshai.dev/api/v1/ingest/v1/traces');
  assert.equal(tracesUrlFor('https://collector.example/v1/traces'), 'https://collector.example/v1/traces');
  assert.equal(tracesUrlFor('ftp://nope.example'), null);
  assert.equal(tracesUrlFor(''), null);
  assert.equal(tracesUrlFor(undefined), null);
});

test('loadTelemetryConfig is disabled unless both endpoint and key are present', () => {
  assert.equal(loadTelemetryConfig({}).enabled, false);
  assert.equal(loadTelemetryConfig({ MESHAI_OTLP_ENDPOINT: 'https://api.meshai.dev/api/v1/ingest' }).enabled, false);
  assert.equal(loadTelemetryConfig({ MESHAI_API_KEY: 'msh_x' }).enabled, false);
  const cfg = loadTelemetryConfig(ENABLED_ENV);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.tracesUrl, 'https://api.meshai.dev/api/v1/ingest/v1/traces');
  assert.equal(cfg.serviceName, 'basemouse');
  assert.equal(cfg.timeoutMs, 3000);
});

test('buildContextPackPayload emits a well-formed OTLP span with evidence, not document bodies', () => {
  const pack = samplePack();
  const config = loadTelemetryConfig(ENABLED_ENV);
  const payload = buildContextPackPayload(pack, { startMs: 1_700_000_000_000, endMs: 1_700_000_000_050 }, config);

  assert.equal(payload.resourceSpans.length, 1);
  const rs = payload.resourceSpans[0];
  assert.equal(findAttr(rs.resource.attributes, 'service.name').value.stringValue, 'basemouse');

  const span = rs.scopeSpans[0].spans[0];
  assert.equal(span.name, 'basemouse.context_pack');
  assert.equal(span.kind, 2);
  assert.match(span.traceId, /^[0-9a-f]{32}$/);
  assert.match(span.spanId, /^[0-9a-f]{16}$/);
  // Timestamps must be strings (MeshAI's OtlpSpan schema requires it).
  assert.equal(typeof span.startTimeUnixNano, 'string');
  assert.equal(span.startTimeUnixNano, '1700000000000000000');

  assert.equal(findAttr(span.attributes, 'gen_ai.operation.name').value.stringValue, 'context_pack');
  assert.equal(findAttr(span.attributes, 'gen_ai.system').value.stringValue, 'basemouse');
  // int64 attributes are encoded as strings per OTLP/JSON.
  assert.equal(findAttr(span.attributes, 'basemouse.entry_count').value.intValue, String(pack.entryCount));

  // Evidence carries document ids, never the document bodies.
  const serialized = JSON.stringify(payload);
  for (const entry of pack.entries) {
    assert.ok(serialized.includes(entry.id), `expected document id ${entry.id} in span`);
    assert.ok(!serialized.includes(entry.body), 'document body must never be emitted to MeshAI');
  }
});

test('createTelemetry no-ops when disabled (never calls fetch)', async () => {
  let called = false;
  const telemetry = createTelemetry(loadTelemetryConfig({}), { fetchImpl: async () => { called = true; return { ok: true }; } });
  assert.equal(telemetry.enabled, false);
  await telemetry.emitContextPack(samplePack(), { startMs: Date.now() });
  assert.equal(called, false);
});

test('createTelemetry POSTs OTLP traces with bearer auth when enabled', async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return { ok: true, status: 200 };
  };
  const telemetry = createTelemetry(loadTelemetryConfig(ENABLED_ENV), { fetchImpl, now: () => 1_700_000_000_000 });
  await telemetry.emitContextPack(samplePack(), { startMs: 1_700_000_000_000 });

  assert.equal(captured.url, 'https://api.meshai.dev/api/v1/ingest/v1/traces');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.authorization, 'Bearer msh_test_key');
  assert.equal(captured.init.headers['content-type'], 'application/json');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.resourceSpans[0].scopeSpans[0].spans[0].name, 'basemouse.context_pack');
});

test('emitContextPack swallows a fetch error and never rejects into the request path', async () => {
  const telemetry = createTelemetry(loadTelemetryConfig(ENABLED_ENV), {
    fetchImpl: async () => { throw new Error('connection refused'); }
  });
  await assert.doesNotReject(() => telemetry.emitContextPack(samplePack(), { startMs: Date.now() }));
});

test('emitContextPack swallows a non-2xx ingest response', async () => {
  const telemetry = createTelemetry(loadTelemetryConfig(ENABLED_ENV), {
    fetchImpl: async () => ({ ok: false, status: 401 })
  });
  await assert.doesNotReject(() => telemetry.emitContextPack(samplePack(), { startMs: Date.now() }));
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

test('GET /api/context-pack emits exactly one telemetry span and still returns the pack', async () => {
  const calls = [];
  const telemetry = { enabled: true, emitContextPack: (pack, meta) => { calls.push({ pack, meta }); return Promise.resolve(); } };
  const server = createApp(createSeedRepository(), { telemetry });
  const base = await listen(server);
  try {
    const res = await fetch(`${base}/api/context-pack?q=agent&limit=3`);
    assert.equal(res.status, 200);
    const pack = await res.json();
    assert.equal(pack.schema, 'basemouse.context_pack.v1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].pack.schema, 'basemouse.context_pack.v1');
    assert.equal(typeof calls[0].meta.startMs, 'number');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a throwing telemetry emitter never breaks the context pull', async () => {
  const telemetry = { enabled: true, emitContextPack: () => { throw new Error('boom'); } };
  const server = createApp(createSeedRepository(), { telemetry });
  const base = await listen(server);
  try {
    const res = await fetch(`${base}/api/context-pack?q=agent`);
    assert.equal(res.status, 200);
    const pack = await res.json();
    assert.equal(pack.schema, 'basemouse.context_pack.v1');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('healthz reports MeshAI integration status', async () => {
  const server = createApp(createSeedRepository(), { telemetry: { enabled: true, emitContextPack: () => Promise.resolve() } });
  const base = await listen(server);
  try {
    const res = await fetch(`${base}/healthz`);
    const body = await res.json();
    assert.equal(body.meshai, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
