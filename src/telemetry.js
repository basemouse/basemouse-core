// MeshAI integration: OpenTelemetry (OTLP/HTTP JSON) evidence emission.
//
// Every context-pack generation is the moment an agent consumes governed,
// cited context. This module turns that moment into a standard OTLP trace span
// and ships it to MeshAI's ingest endpoint, so MeshAI can observe, attribute,
// and audit what context which agent pulled. The wire format is vendor-neutral
// OTLP, so the same emission lights up any OTel backend (Datadog, Honeycomb,
// Grafana Tempo) — MeshAI is one consumer, not a proprietary coupling.
//
// Zero dependencies: OTLP/HTTP JSON is just a JSON POST, so we build the
// payload by hand with built-in fetch instead of pulling the OpenTelemetry SDK,
// keeping BaseMouse installable with no node_modules.
//
// Safe by default: when MESHAI_OTLP_ENDPOINT / MESHAI_API_KEY are absent, the
// integration is disabled and emit is a no-op. Emission is fire-and-forget with
// a hard timeout and total error containment — a slow or down MeshAI can never
// delay or break a context pull. We emit evidence (document ids, counts,
// checksums of what was served) but never the document bodies, so a customer's
// knowledge base is never copied to MeshAI.
//
//   /api/context-pack ──> createContextPack ──> sendJson (response)
//                                  │
//                                  └─(fire-and-forget)─> emitContextPack
//                                          │ build OTLP span
//                                          ▼
//                            POST {endpoint}/v1/traces  (Bearer msh_…)
//                            timeout 3s · errors swallowed · no retry (v1)

import { randomBytes } from 'node:crypto';

const SCOPE_NAME = 'basemouse';
const SCOPE_VERSION = '0.2.0';
const SPAN_KIND_SERVER = 2; // OTLP SpanKind.SERVER
const STATUS_CODE_OK = 1; // OTLP StatusCode.OK
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_DOCUMENT_IDS = 50;

function stringOrNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Resolve the OTLP traces URL from a configured base endpoint. Mirrors how OTLP
// HTTP exporters work: the base (e.g. https://api.meshai.dev/api/v1/ingest) gets
// `/v1/traces` appended unless it is already present. Returns null for a missing
// or non-http(s) endpoint so the integration stays disabled rather than POSTing
// somewhere unexpected.
export function tracesUrlFor(endpoint) {
  const raw = stringOrNull(endpoint);
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const base = raw.replace(/\/+$/, '');
  return /\/v1\/traces$/.test(base) ? base : `${base}/v1/traces`;
}

// Build the server-side MeshAI telemetry config from environment variables.
// Pure with respect to its `env` argument so tests can pass a fixture. The API
// key is server-only and must never be serialized to a browser.
export function loadTelemetryConfig(env = process.env) {
  const tracesUrl = tracesUrlFor(env.MESHAI_OTLP_ENDPOINT);
  const apiKey = stringOrNull(env.MESHAI_API_KEY);
  const parsedTimeout = Number.parseInt(env.MESHAI_OTLP_TIMEOUT_MS || '', 10);
  return {
    enabled: Boolean(tracesUrl && apiKey),
    tracesUrl,
    apiKey, // server-only secret — never include in publicBillingConfig or any response
    serviceName: stringOrNull(env.MESHAI_SERVICE_NAME) || 'basemouse',
    timeoutMs: Number.isInteger(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : DEFAULT_TIMEOUT_MS,
    maxDocumentIds: DEFAULT_MAX_DOCUMENT_IDS
  };
}

// Encode a JS value as an OTLP AnyValue-bearing key/value attribute. int64 is
// emitted as a string per the OTLP/JSON (protojson) encoding so strict OTLP
// collectors accept it too, not just MeshAI's permissive schema.
function attr(key, value) {
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  if (Array.isArray(value)) {
    return { key, value: { arrayValue: { values: value.map((v) => ({ stringValue: String(v) })) } } };
  }
  return { key, value: { stringValue: String(value) } };
}

function unixNano(ms) {
  return String(BigInt(Math.trunc(ms)) * 1_000_000n);
}

// Build the OTLP/HTTP JSON ResourceSpans payload for one context-pack event.
// Pure and side-effect free (apart from random span/trace ids) so it is trivially
// testable. Emits identity + retrieval evidence, never document bodies.
export function buildContextPackPayload(pack, { startMs, endMs }, config) {
  const ids = Array.isArray(pack?.entries)
    ? pack.entries.map((entry) => entry.id).filter(Boolean).slice(0, config.maxDocumentIds)
    : [];

  const spanAttributes = [
    attr('gen_ai.system', 'basemouse'),
    attr('gen_ai.operation.name', 'context_pack'),
    attr('basemouse.schema', pack?.schema || 'basemouse.context_pack.v1'),
    attr('basemouse.entry_count', Number.isInteger(pack?.entryCount) ? pack.entryCount : 0),
    attr('basemouse.total_matches', Number.isInteger(pack?.totalMatches) ? pack.totalMatches : 0),
    attr('basemouse.truncated', Boolean(pack?.truncated))
  ];
  if (pack?.query) spanAttributes.push(attr('basemouse.query', pack.query));
  if (pack?.filters?.type) spanAttributes.push(attr('basemouse.filter.type', pack.filters.type));
  if (pack?.filters?.tag) spanAttributes.push(attr('basemouse.filter.tag', pack.filters.tag));
  if (ids.length > 0) spanAttributes.push(attr('basemouse.document_ids', ids));

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            attr('service.name', config.serviceName),
            attr('service.version', SCOPE_VERSION),
            attr('meshai.agent.framework', 'basemouse'),
            attr('gen_ai.system', 'basemouse')
          ]
        },
        scopeSpans: [
          {
            scope: { name: SCOPE_NAME, version: SCOPE_VERSION },
            spans: [
              {
                traceId: randomBytes(16).toString('hex'),
                spanId: randomBytes(8).toString('hex'),
                name: 'basemouse.context_pack',
                kind: SPAN_KIND_SERVER,
                startTimeUnixNano: unixNano(startMs),
                endTimeUnixNano: unixNano(endMs),
                attributes: spanAttributes,
                status: { code: STATUS_CODE_OK }
              }
            ]
          }
        ]
      }
    ]
  };
}

// Construct the telemetry emitter. `fetchImpl` and `now` are injectable so the
// emission can be tested without network or a real clock.
export function createTelemetry(config, { fetchImpl = fetch, now = Date.now } = {}) {
  async function emitContextPack(pack, meta = {}) {
    if (!config.enabled) return;
    try {
      const startMs = typeof meta.startMs === 'number' ? meta.startMs : now();
      const endMs = now();
      const payload = buildContextPackPayload(pack, { startMs, endMs }, config);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const res = await fetchImpl(config.tracesUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.apiKey}`
          },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        if (res && res.ok === false) {
          console.warn(`meshai_telemetry: ingest responded ${res.status}`);
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      // Best-effort evidence emission: telemetry failures must never touch the
      // context-pull path. Drop with a warning; no retry in v1.
      console.warn('meshai_telemetry: emit failed', error?.message || String(error));
    }
  }

  return { enabled: config.enabled, emitContextPack };
}
