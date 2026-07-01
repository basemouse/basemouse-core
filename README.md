# BaseMouse

**Hosted service:** https://basemouse.com
**GitHub org:** https://github.com/basemouse
**License:** MIT (see [`LICENSE`](LICENSE))

BaseMouse is an AI-native document/notes repository for workspaces and agents: a local-first knowledge base that exports structured, versioned context packs agents can actually use.

This repository is the **open-core engine** — MIT-licensed, self-hostable, no license key, no phone-home. See [`docs/open-source.md`](docs/open-source.md) for the full hosted-vs-self-hosted positioning and an honest shipped-vs-roadmap breakdown.

## What's in this repo

This is a small zero-dependency Node.js app:

- durable in-repo seed repository in `data/seed/*.json`
- `/api/repository` endpoint with count + normalized documents
- `/api/search?q=...` search endpoint with scores and matched terms
- `/api/context-pack?q=...&limit=...` agent-ready `basemouse.context_pack.v1` export
- Faceted retrieval filters `type` and `tag` on both `/api/search` and `/api/context-pack`
- `retrieval=lexical|hybrid` mode on both endpoints (lexical is the default, fully back-compatible). `hybrid` blends three signals — `lexical` term overlap, one-hop `graph` expansion along document links, and a local `vector` similarity — and annotates every result with a per-signal `retrieval` block explaining *why* it surfaced. The vector signal uses **local, offline hashed-feature embeddings** built in Node (no external vector DB, no paid embedding API, no network); it is honest token-overlap-in-a-dense-space, not a semantic model. Disable it with `BASEMOUSE_VECTOR_RETRIEVAL=off` (graph+lexical hybrid still works).
- context-pack citations, provenance, document versions, checksums, relevance, truncation, and agent instructions
- graph-aware relationships: each entry carries its outbound `links` and a resolved `related` list, plus a pack-level `relationships` edge list, so agents can follow how documents connect
- safer static file serving with path containment, nosniff headers, malformed URL handling, and API validation/limits
- web UI for search, context-pack generation, raw JSON inspection, copy, and download
- public Agent Governance Demo page at `/agent-governance-demo.html`, showing
  the synthetic governance corpus, sample auditor/operator queries, and the
  lexical vs hybrid retrieval-quality baseline
- public Design Partner Intake page at `/design-partner.html`, asking for one
  small real corpus, real questions, and a concrete agent workflow to benchmark
- lightweight JavaScript and Python API clients in `clients/` (see `docs/client-libraries.md`)
- Slack Socket Mode connector for local LLM + BaseMouse grounding in `integrations/slack/`
- Dockerfile plus self-hosted Docker Compose examples in `deployment/compose/` (see `docs/self-hosted.md`)
- retrieval quality eval harness (`npm run eval:retrieval`) with golden queries in `data/retrieval-eval/`

## Local development

```bash
npm test
npm run lint
npm run eval:retrieval
npm run eval:retrieval:demo
npm run dev
```

Open:

```text
http://localhost:3000
http://localhost:3000/agent-governance-demo.html
http://localhost:3000/design-partner.html
```

Useful endpoints:

```text
GET    /healthz                          (liveness, process-only)
GET    /readyz                           (readiness; 200 + degraded:true in demo-fallback mode)
GET    /api/repository?limit=&offset=    (paginated; anonymous sees the public demo corpus)
GET    /api/search?q=agent%20context
GET    /api/search?q=agent&type=feature
GET    /api/context-pack?q=memory&limit=3
GET    /api/context-pack?tag=memory
GET    /api/billing/config
POST   /api/checkout
POST   /api/documents                    (requires Authorization: Bearer bm_...)
PUT    /api/documents/:id                (optimistic lock: expectedVersion or If-Match)
DELETE /api/documents/:id                (tombstone — history preserved)
GET    /api/documents/:id/history
GET    /api/usage                        (plan, documents, pack pulls, storage vs limits)
POST   /api/keys/claim                   (exchange a paid checkout session for a key — shown once)
POST   /api/keys/rotate                  (authenticated; old key dies immediately)
POST   /api/billing/portal               (authenticated; Stripe-hosted cancel/payment management)
POST   /api/stripe/webhook               (Stripe events; SDK-verified signature)
GET    /claim?session_id=...             (post-checkout claim page, five designed states)
```

### Write API and persistence

With `DATABASE_URL` set (managed Postgres), BaseMouse runs a durable
store: API keys scope private workspaces, writes are append-only revisions, and
the public demo corpus survives database outages by degrading to the in-repo
seeds (`X-BaseMouse-Degraded: true`). Without `DATABASE_URL` the app runs the
in-memory seed store exactly as before. Provide `DATABASE_CA_CERT` (PEM) when
the provider's server cert chains to a private CA — TLS verification is never
disabled.

```bash
# issue a key for your workspace
DATABASE_URL=... node scripts/issue-key.mjs --plan demo

# import a folder of markdown into your workspace
BASEMOUSE_API_KEY=bm_... node scripts/import.mjs ./docs --base-url http://localhost:3000

# post-deploy smoke check
node scripts/smoke.mjs --base-url http://localhost:3000

# apply migrations
DATABASE_URL=... node scripts/migrate.mjs
```

### The round trip (write a doc, watch an agent cite it)

```bash
# 1. write a document into your workspace
curl -s -X POST http://localhost:3000/api/documents \
  -H "Authorization: Bearer $BASEMOUSE_API_KEY" -H "Content-Type: application/json" \
  -d '{"id":"release-policy","title":"Release Policy","body":"Never deploy on Fridays.","type":"policy"}'

# 2. pull a context pack that cites it — note the checksum and version
curl -s "http://localhost:3000/api/context-pack?q=release+policy" \
  -H "Authorization: Bearer $BASEMOUSE_API_KEY" | head -40

# 3. the record is append-only — edit it, then ask for the history
curl -s http://localhost:3000/api/documents/release-policy/history \
  -H "Authorization: Bearer $BASEMOUSE_API_KEY"
```

### MCP (connect your agent natively)

BaseMouse speaks the Model Context Protocol at `POST /mcp` (stateless
Streamable HTTP, JSON-RPC). Tools: `search`, `get_context_pack` — same auth,
scoping, and quota metering as REST. Claude Code:

```bash
claude mcp add --transport http basemouse http://localhost:3000/mcp \
  --header "Authorization: Bearer bm_..."
```

(Omit the header to browse the public demo corpus. OAuth-based hosted
connectors are not yet supported — config-file clients like Claude Code and
Cursor work today.)

### Operations

`GET /metrics` exposes Prometheus-format counters (pack pulls, quota denials,
claims, degraded state). Set `ALERT_WEBHOOK_URL` (ntfy/Slack) and the app
pages you when degraded mode persists >5m or claim failures spike. The
OpenAPI spec lives at `/api/openapi.json`.

`GET /healthz` reports liveness plus non-secret deployment posture: `billing`
and `meshai` enablement and a `license` object (mode, tier, whether a license
key is present, expiry). The license key value is server-only and never appears
in any response — see `docs/enterprise-self-hosted.md`.

### Faceted filters

Both `/api/search` and `/api/context-pack` accept optional `type` and `tag` query
parameters:

- `type` — case-insensitive match against the document type
  (`concept`, `feature`, `experience`, `principle`, `note`, `policy`).
- `tag` — case-insensitive match against a document's tags.

Empty parameters are treated as "no filter". A value longer than 256 characters
returns `400 { "error": "invalid_filter", "message": "..." }`.

Both endpoints echo the applied filters back in a `filters` field, e.g.
`"filters": { "type": "feature", "tag": null }`. For context packs the filter is
applied to the candidate set before the `limit`, so `totalMatches` and
`truncated` reflect the post-filter count.

```text
GET /api/search?q=agent&type=feature  ->  only feature-type results
GET /api/context-pack?tag=memory      ->  pack entries all tagged "memory"
```

Example context-pack shape:

```json
{
  "schema": "basemouse.context_pack.v1",
  "query": "memory",
  "filters": { "type": null, "tag": null },
  "entryCount": 1,
  "totalMatches": 1,
  "truncated": false,
  "citations": [
    {
      "id": "memory-capsules",
      "label": "[memory-capsules] Memory Capsules v1"
    }
  ],
  "entries": [
    {
      "id": "memory-capsules",
      "links": ["agent-context-engine", "ghost-doc"],
      "relevance": { "score": 3, "matchedTerms": ["memory"] },
      "related": [
        { "id": "agent-context-engine", "title": "Agent Context Engine", "inPack": true },
        { "id": "ghost-doc", "title": null, "inPack": false }
      ],
      "provenance": {
        "source": { "kind": "seed", "path": "data/seed/memory-capsules.json" },
        "checksum": "..."
      }
    }
  ],
  "relationships": [
    { "from": "memory-capsules", "to": "agent-context-engine", "resolved": true },
    { "from": "memory-capsules", "to": "ghost-doc", "resolved": false }
  ]
}
```

## Billing / Stripe setup

BaseMouse renders paid Starter, Team, and Enterprise plans from `/api/billing/config`.
`POST /api/checkout` creates a Stripe Checkout Session for self-serve tiers when Stripe is configured. If the env vars are absent, the UI and API degrade to a clear contact-sales state; no payment or customer data is stored locally. This code path is shared between the hosted service and self-hosted installs — it's entirely optional for self-hosting.

Environment variables:

```text
CHECKOUT_ENABLED        # Master switch for self-serve Stripe checkout (required to enable paid tiers)
STRIPE_SECRET_KEY       # server-only restricted key (rk_ preferred; sk_ also works)
STRIPE_WEBHOOK_SECRET   # endpoint signing secret from Stripe → Webhooks
STRIPE_PRICE_STARTER    # Stripe recurring Price ID for Starter
STRIPE_PRICE_TEAM       # Stripe recurring Price ID for Team
STRIPE_PUBLISHABLE_KEY  # optional public key for future Stripe client surfaces
STRIPE_API_VERSION      # optional; defaults to the pinned app version
APP_BASE_URL            # optional; defaults to http://localhost:3000 for checkout return URLs
BILLING_SUCCESS_URL     # optional explicit Checkout success URL
BILLING_CANCEL_URL      # optional explicit Checkout cancellation URL
BILLING_CONTACT_URL     # optional mailto/CRM URL for Enterprise/contact-sales fallback
STRIPE_PRICING_TABLE_ID # optional public ID reserved for future pricing table embed
```

Set up your own Stripe product/prices and point the env vars above at them —
see [`docs/stripe.md`](docs/stripe.md) for the price/webhook shape this app expects.
Never commit secrets to git; load them from your environment or secret manager.

## Seed documents

Seed documents live in:

```text
data/seed/*.json
```

Each document is normalized by `src/store.js`, gets deterministic provenance metadata, and receives a stable 16-character SHA-256 checksum from the normalized content.

## Key docs

- [`docs/BaseMouse_Technical_Documentation_v1.1.md`](docs/BaseMouse_Technical_Documentation_v1.1.md)
- [`docs/stripe.md`](docs/stripe.md) — Stripe product/price mapping, webhook events, verification
- [`docs/open-source.md`](docs/open-source.md) — open-core positioning; shipped vs roadmap
- [`docs/retrieval-eval.md`](docs/retrieval-eval.md) — golden-query retrieval quality harness
- [`docs/demo-corpus-agent-governance.md`](docs/demo-corpus-agent-governance.md) — public Agent Governance Demo corpus, page, and eval baseline
- [`docs/self-hosted.md`](docs/self-hosted.md) — run BaseMouse + local LLM + Slack inside a company network
- [`docs/enterprise-self-hosted.md`](docs/enterprise-self-hosted.md) — VPC/internal DNS, API keys, audit, licensing envs, Stripe parity constraints (SSO/RBAC/GraphRAG marked roadmap)
- [`docs/marketplace.md`](docs/marketplace.md) — marketplace/plugin directory shape (roadmap)

## Product thesis

> The repository that agents actually love.

**Shipped today** (see [`docs/open-source.md`](docs/open-source.md) for the
authoritative, test-backed list):

- Agent Context Engine — structured/versioned `basemouse.context_pack.v1` exports
- retrieval: lexical + faceted + **graph-aware** linking + metadata, with
  citations and provenance
- **hybrid retrieval** — opt-in `retrieval=hybrid` blends one-hop graph
  expansion over document links, lexical term overlap, and a local hashed-vector
  similarity, with per-result signal explanations (`lexical` / `vector` /
  `graph`). Vectors are **local/offline hashed-feature embeddings** (no external
  vector DB, no paid embedding API), toggled with `BASEMOUSE_VECTOR_RETRIEVAL`.
- retrieval quality harness — `npm run eval:retrieval` scores search and
  context-pack output against strict golden-query suites; the seed suite is a
  smoke test and partner-corpus suites are the next quality gate.
- local-first / self-hosted privacy
- append-only history & audit trail

**Vision / roadmap** (not implemented yet — listed as direction, not claims):

- real-corpus retrieval eval suites (human-reviewed expected docs, CI quality
  gates) before further retrieval tuning
- semantic vector retrieval (today's vectors are local hashed-feature embeddings —
  shared-vocabulary overlap in a dense space, not a learned semantic model; a real
  embedding provider can be plugged into the same vector path)
- full GraphRAG (multi-hop traversal + learned embeddings over the relationship
  graph; today's hybrid mode is one-hop graph expansion plus local hashed vectors)
- memory capsules
- built-in agent sandbox
- precision canvas UX

## MeshAI integration (OpenTelemetry)

BaseMouse emits a standard OTLP/HTTP trace span for every context pack it
generates, so [MeshAI](https://meshai.dev) (or any OpenTelemetry backend) can
observe, attribute, and audit what context agents pull. The wire format is
vendor-neutral OTLP, so the same emission also works with Datadog, Honeycomb,
or Grafana Tempo.

It is disabled by default and is a no-op until configured. No document bodies
are ever sent: spans carry retrieval evidence only (query, counts, document ids).

Configure via environment variables:

```text
MESHAI_OTLP_ENDPOINT   # e.g. https://api.meshai.dev/api/v1/ingest (no-op if unset)
MESHAI_API_KEY         # MeshAI API key (msh_...) with the telemetry:write scope
MESHAI_SERVICE_NAME    # optional, defaults to "basemouse"
MESHAI_OTLP_TIMEOUT_MS # optional, defaults to 3000
```

Spans are POSTed to `${MESHAI_OTLP_ENDPOINT}/v1/traces` with a `Bearer` token.
Each `/api/context-pack` request emits one span named `basemouse.context_pack`
with `service.name`, `gen_ai.system=basemouse`, `gen_ai.operation.name=context_pack`,
and `basemouse.*` evidence attributes. Emission is fire-and-forget with a hard
timeout: if MeshAI is slow or down, the context pack is still returned normally.

`GET /healthz` reports whether the integration is configured (`"meshai": true`).
