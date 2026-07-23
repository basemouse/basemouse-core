# Self-hosted BaseMouse + Local LLM + Slack

BaseMouse can run inside a company network as the context layer for local agents. Slack uses Socket Mode, so the bot only needs outbound WebSocket/HTTPS to Slack; BaseMouse and the LLM can remain on LAN/private DNS.

```text
Slack workspace
  -> Slack Socket Mode bot (optional compose profile)
  -> BaseMouse API (internal HTTP)
  -> Ollama/vLLM/LM Studio (internal OpenAI-compatible /v1)
```

## Quick start

```bash
cp deployment/compose/.env.example deployment/compose/.env
# edit tokens and ports
```

All commands below run from the repo root. (`COMPOSE=...` is just shorthand.)

```bash
COMPOSE="docker compose -f deployment/compose/docker-compose.yml --env-file deployment/compose/.env"
```

### Run the published image (recommended)

The compose file defaults the BaseMouse service to the published multi-arch
image `ghcr.io/basemouse/basemouse:latest`, so a fresh checkout needs no local
build toolchain:

```bash
$COMPOSE pull basemouse        # fetch the prebuilt image from GHCR
$COMPOSE up -d basemouse       # start it in the background
```

The image is published by CI (`.github/workflows/deploy.yml`) as both
`:latest` and a per-commit `:<sha>` tag. If your GHCR package is private,
`docker login ghcr.io` first; pin to a `:<sha>` tag for reproducible deploys.

### Build from source instead

To run your own build (e.g. local changes), either pass `--build` — which builds
this repo's `Dockerfile` and tags it as the configured image — or point
`BASEMOUSE_IMAGE` at a local tag in `.env`:

```bash
$COMPOSE up --build basemouse                 # build & run from source
# or, in .env:  BASEMOUSE_IMAGE=basemouse-local:latest
```

`BASEMOUSE_IMAGE` (documented in `.env.example`) selects which image runs;
leaving it unset uses the GHCR default.

Open `http://localhost:3000` and check:

```bash
curl -fsS http://localhost:3000/healthz
curl -fsS http://localhost:3000/readyz
```

## Add a local LLM

```bash
docker compose -f deployment/compose/docker-compose.yml --env-file deployment/compose/.env --profile llm up --build
# then, in another shell after Ollama is up:
docker compose -f deployment/compose/docker-compose.yml exec ollama ollama pull llama3.2
```

For an external vLLM or LM Studio server, skip the `llm` profile and set `LLM_BASE_URL=http://your-host:port/v1`.

## Add Slack

The `slack` profile expects `integrations/slack/` and its Dockerfile.

```bash
docker compose -f deployment/compose/docker-compose.yml --env-file deployment/compose/.env --profile slack up --build
```

Slack app requirements are documented in [`integrations/slack/README.md`](../integrations/slack/README.md). Required env:

```text
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
BASEMOUSE_TOKEN=bm_...
LLM_BASE_URL=http://ollama:11434/v1
LLM_MODEL=llama3.2:latest
```

## Persistence

- Without `DATABASE_URL`, BaseMouse uses its in-memory/dev seed store. This is useful for demos but not durable.
- For production, set `DATABASE_URL` to managed Postgres and run migrations:

```bash
DATABASE_URL=... node scripts/migrate.mjs
```

- The compose file mounts `basemouse-data` for seed/import artifacts and `slack-state` for optional SQLite bot history.

## Import Markdown

```bash
BASEMOUSE_API_KEY=bm_... node scripts/import.mjs ./docs --base-url http://localhost:3000
```

Markdown frontmatter can carry project metadata:

```markdown
---
project: alpha
type: spec
tags: [auth, security]
---
```

## Internal DNS / networking

Typical company DNS names:

```text
http://basemouse.internal:3000
http://llm.internal:8000/v1
```

Expose BaseMouse and the LLM only to trusted networks. Slack does not need inbound access to either service when using Socket Mode.

## Licensing & enterprise posture

Self-hosted deployments can record their commercial posture via environment
variables. This is **informational only** — it never blocks local/dev use and
does not gate features (enforcement is a roadmap item):

```text
BASEMOUSE_LICENSE_TIER=enterprise   # open | starter | team | enterprise
BASEMOUSE_SELF_HOSTED=true
# BASEMOUSE_LICENSE_KEY=bml_...      # presence reported on /healthz; value never echoed
# BASEMOUSE_LICENSE_EXPIRES_AT=2027-01-01
```

`/healthz` reports the non-secret posture under a `license` object (mode, tier,
whether a key is present, expiry). The key value is server-only.

## Security checklist

- Keep `BASEMOUSE_TOKEN`, Slack tokens, and LLM credentials in `.env`/secret managers only.
- Prefer private IPs/VPC networking or mTLS for service-to-service traffic.
- Use Postgres with TLS for durable enterprise deployments.
- Restrict API keys per workspace and rotate keys via `/api/keys/rotate`.
- Monitor `/metrics`, `/readyz`, and degraded-mode headers.
- Do not publish the local LLM endpoint directly to the internet.

## Validation

Static compose validation (does not require Docker daemon):

```bash
node scripts/validate-compose.mjs
```

If Docker Compose is available:

```bash
docker compose -f deployment/compose/docker-compose.yml --env-file deployment/compose/.env.example config
```
