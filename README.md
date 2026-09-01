# BaseMouse

**Domain:** basemouse.com  
**GitHub org:** https://github.com/basemouse  
**Status:** live (paid plans)
**Version:** v0.3

BaseMouse is an AI-native document/notes repository for workspaces and agents: a local-first knowledge base that exports structured, versioned context packs agents can actually use.

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
- public alternatives/comparison page at `/compare.html`, covering the five
  things people use instead of BaseMouse and where BaseMouse is the wrong tool
- JSON-LD structured data (Organization, WebSite, SoftwareApplication, FAQPage)
  on the homepage, pinned to `src/billing.js` and the visible FAQ by
  `test/structured-data.test.js` so the markup cannot drift from the product
- lightweight JavaScript and Python API clients in `clients/` (see `docs/client-libraries.md`)
- Slack Socket Mode connector for local LLM + BaseMouse grounding in `integrations/slack/`
- Dockerfile plus self-hosted Docker Compose examples in `deployment/compose/` (see `docs/self-hosted.md`)
- retrieval quality eval harness (`npm run eval:retrieval`) with golden queries in `data/retrieval-eval/`
- GitHub Actions workflow for test/build/push on `main`

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
http://localhost:3000/compare.html
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
GET    /api/documents/:id                (current revision, workspace-scoped)
PUT    /api/documents/:id                (optimistic lock: expectedVersion or If-Match)
PUT    /api/documents/:id?mode=upsert    (idempotent: created/updated/unchanged — no version needed)
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

With `DATABASE_URL` set (managed Postgres — Supabase), BaseMouse runs a durable
store: API keys scope private workspaces, writes are append-only revisions, and
the public demo corpus survives database outages by degrading to the in-repo
seeds (`X-BaseMouse-Degraded: true`). Without `DATABASE_URL` the app runs the
in-memory seed store exactly as before. Provide `DATABASE_CA_CERT` (PEM) when
the provider's server cert chains to a private CA — TLS verification is never
disabled.

```bash
# issue a design-partner key (run via kubectl exec, never from a workstation)
DATABASE_URL=... node scripts/issue-key.mjs --plan demo

# import a folder of markdown into your workspace
BASEMOUSE_API_KEY=bm_... node scripts/import.mjs ./docs --base-url https://basemouse.com

# post-deploy smoke check
node scripts/smoke.mjs --base-url https://basemouse.com

# apply migrations (CI does this automatically before deploy)
DATABASE_URL=... node scripts/migrate.mjs
```

### The round trip (write a doc, watch an agent cite it)

```bash
# 1. write a document into your workspace
curl -s -X POST https://basemouse.com/api/documents \
  -H "Authorization: Bearer $BASEMOUSE_API_KEY" -H "Content-Type: application/json" \
  -d '{"id":"release-policy","title":"Release Policy","body":"Never deploy on Fridays.","type":"policy"}'

# 2. pull a context pack that cites it — note the checksum and version
curl -s "https://basemouse.com/api/context-pack?q=release+policy" \
  -H "Authorization: Bearer $BASEMOUSE_API_KEY" | head -40

# 3. the record is append-only — edit it, then ask for the history
curl -s https://basemouse.com/api/documents/release-policy/history \
  -H "Authorization: Bearer $BASEMOUSE_API_KEY"
```

### MCP (connect your agent natively)

BaseMouse speaks the Model Context Protocol at `POST /mcp` (stateless
Streamable HTTP, JSON-RPC). Tools: `search`, `get_context_pack`, and
`upsert_document` (the write door — agents can persist decisions and session
context by stable id, idempotently; unchanged content writes nothing) — same
auth, scoping, and quota metering as REST. Claude Code:

```bash
claude mcp add --transport http basemouse https://basemouse.com/mcp \
  --header "Authorization: Bearer bm_..."
```

Unauthenticated POST /mcp returns 401 with WWW-Authenticate so Cursor
marketplace Connect starts OAuth. Paste an existing bm_ key on the consent
page, or continue with the public demo. Config-file clients still send
`Authorization: Bearer bm_...`. REST anonymous demo is unchanged. The
endpoint is tool-agnostic: `node integrations/cli/basemouse.mjs register`
prints ready-to-paste MCP config for Claude Code, Cursor, Windsurf, Codex
CLI, Gemini CLI, Grok CLI, AWS Kiro, and Google Antigravity — and SSE-only
clients like IBM Bob via the `mcp-remote` bridge, which `basemouse register bob`
emits.

### Sync your workspace (any platform, any coding tool)

> New here? **[docs/getting-started.md](docs/getting-started.md)** maps your
> situation to the right import path (coding workspace vs. any Markdown folder
> vs. GitHub repo) — the `sync` CLI below is tailored to the AI-coding-workspace
> layout (`CLAUDE.md`/`PROGRESS.md` per project); for arbitrary Markdown use
> `scripts/import.mjs` instead.

`integrations/cli/basemouse.mjs` is a zero-dependency Node CLI that keeps a
projects workspace synced into BaseMouse as `project:<slug>`-tagged, versioned
documents. Node-only — no bash/curl/jq — so it behaves identically on
Windows, macOS, and Linux:

```bash
# one-shot: push every project's CLAUDE.md/PROGRESS.md under ~/projects
BASEMOUSE_API_KEY=bm_... node integrations/cli/basemouse.mjs sync

# continuous: reconcile once, then auto-push a project the moment its docs are saved
BASEMOUSE_API_KEY=bm_... node integrations/cli/basemouse.mjs watch

# one project directory (what CI uses)
BASEMOUSE_API_KEY=bm_... node integrations/cli/basemouse.mjs sync --single . --slug myproject

# MCP config for your coding tool (claude|cursor|windsurf|codex|gemini)
node integrations/cli/basemouse.mjs register

# the CLAUDE.md "Context retrieval" block for a project
node integrations/cli/basemouse.mjs snippet myproject
```

Sync is idempotent and cheap: **one `PUT ?mode=upsert` per doc** — the server
decides created/unchanged/updated next to its own normalization (no client-side
comparison to drift), merges tags additively so tags you added elsewhere are
never destroyed, and an unchanged save writes nothing. Per-doc failures warn
and continue (empty stub files are skipped, not failed, so CI stays green).
Requires Node 20+ and a server with upsert support (basemouse.com, or
self-hosted at the D9 release or later — older servers get a clear upgrade
message). Override `BASEMOUSE_BASE_URL` for self-hosted, `--base-dir`/`BASE_DIR`
for a different workspace root.

### Sync on git push (GitHub Action)

For the most hands-off setup, let sync ride on `git push` — no daemon, no
per-machine key, works from any OS/editor. Add the repo secret
`BASEMOUSE_API_KEY`, then in `.github/workflows/basemouse-sync.yml`:

```yaml
name: basemouse-sync
on:
  push:
    branches: [main]
    paths: ['CLAUDE.md', 'PROGRESS.md']
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: basemouse/basemouse-core/integrations/github-action@master
        with:
          api-key: ${{ secrets.BASEMOUSE_API_KEY }}
```

The action syncs the repo's `CLAUDE.md`/`PROGRESS.md` tagged
`project:<repo-name>` (override with the `slug` input; `base-url` targets a
self-hosted instance).

> `integrations/claude-code/basemouse-integration.sh` (bash) is deprecated in
> favour of the CLI — it still works, but only receives fixes.

### Operations

`GET /metrics` exposes Prometheus-format counters (pack pulls, quota denials,
claims, degraded state). Set `ALERT_WEBHOOK_URL` (ntfy/Slack) and the app
pages you when degraded mode persists >5m or claim failures spike. The
OpenAPI spec lives at `/api/openapi.json`.

`GET /healthz` reports liveness plus non-secret deployment posture: `billing`
and `meshai` enablement and a `license` object (mode, tier, whether a license
key is present, expiry). The license key value is server-only and never appears
in any response.

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
`POST /api/checkout` creates a Stripe Checkout Session for self-serve tiers when Stripe is configured. If the env vars are absent, the UI and API degrade to a clear contact-sales state; no payment or customer data is stored locally.

Environment variables:

```text
CHECKOUT_ENABLED        # Master switch for self-serve Stripe checkout (required to enable paid tiers)
STRIPE_SECRET_KEY       # server-only restricted key (rk_ preferred; sk_ also works)
STRIPE_WEBHOOK_SECRET   # endpoint signing secret from Stripe → Webhooks
STRIPE_PRICE_STARTER    # Stripe recurring Price ID for Starter
STRIPE_PRICE_TEAM       # Stripe recurring Price ID for Team
STRIPE_PUBLISHABLE_KEY  # optional public key for future Stripe client surfaces
STRIPE_API_VERSION      # optional; defaults to the pinned app version
APP_BASE_URL            # optional; defaults to https://basemouse.com for checkout return URLs
BILLING_SUCCESS_URL     # optional explicit Checkout success URL
BILLING_CANCEL_URL      # optional explicit Checkout cancellation URL
BILLING_CONTACT_URL     # optional mailto/CRM URL for Enterprise/contact-sales fallback
STRIPE_PRICING_TABLE_ID # optional public ID reserved for future pricing table embed
```

To take real payments:

1. In Stripe, create a product with recurring monthly prices, tagging each price
   with `tier` metadata (`starter` or `team`). The app matches tiers by that tag,
   not by price ID order.
2. Create a webhook endpoint pointing at `/api/stripe/webhook` and copy its
   signing secret into `STRIPE_WEBHOOK_SECRET`.
3. Set the variables above in the server environment along with
   `CHECKOUT_ENABLED=true`. Never commit them. For local development put the same
   names in `.env` (see `.env.sample`).
4. Verify `/api/billing/config` shows checkout-enabled tiers without exposing any
   secret, and that `/api/stripe/webhook` accepts Stripe test events.

A restricted key (`rk_…`) is preferred over a secret key. The minimum scopes are
write on Checkout Sessions and Billing Portal Sessions, plus read on Checkout
Sessions for the claim verification path.

Checkout arms itself once `STRIPE_SECRET_KEY` and at least one price ID are
present, and degrades to a contact-sales state when they are absent, so a
deployment with no Stripe configuration still runs.

## Seed documents

Seed documents live in:

```text
data/seed/*.json
```

Each document is normalized by `src/store.js`, gets deterministic provenance metadata, and receives a stable 16-character SHA-256 checksum from the normalized content.

## Deployment

The hosted service runs on Kubernetes and deploys continuously from `main`: a
build pushes the image, migrations run against the production database, and the
cluster rolls out the new revision. Self-hosters can deploy the same image with
the Docker Compose examples in `deployment/compose/` (see `docs/self-hosted.md`).

Set `CANONICAL_HOST` to your bare domain (e.g. `example.com`) if you serve the
same site on both the apex and `www.` hostnames: GET and HEAD requests arriving
on `www.<CANONICAL_HOST>` are then 308'd to the bare host, so crawlers index one
origin instead of two. Only GET and HEAD are redirected, so the POST traffic that
carries every API, MCP, and webhook call is never moved. Leave it unset
to disable the redirect entirely — that is the default.

## Key docs

- [`docs/getting-started.md`](docs/getting-started.md) — first calls against the API and MCP endpoint
- [`docs/agent-integration.md`](docs/agent-integration.md) — wiring BaseMouse into agents and MCP clients
- [`docs/client-libraries.md`](docs/client-libraries.md) — JavaScript and Python API clients
- [`docs/retrieval-eval.md`](docs/retrieval-eval.md) — golden-query retrieval quality harness
- [`docs/demo-corpus-agent-governance.md`](docs/demo-corpus-agent-governance.md) — public Agent Governance Demo corpus, page, and eval baseline
- [`docs/self-hosted.md`](docs/self-hosted.md) — run BaseMouse + local LLM + Slack inside a company network

## Product thesis

> The repository that agents actually love.

**Shipped today**:

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
