# Getting Started

You have (or want) a BaseMouse workspace and you want your documents in it, so
your agents can pull grounded, cited context. This is the whole path: get a
key → import your docs → connect your tool → verify.

Every key is its own **private, tenant-isolated workspace** — you see your own
documents plus the public demo corpus; your writes go only to your workspace,
and no other key can read them.

## 1. Get a key

- **Hosted (basemouse.com):** pick a plan at <https://basemouse.com/#pricing>,
  pay via Stripe, and claim your key — it's shown **exactly once**, so save it.
- **Self-hosted:** issue one with `node scripts/issue-key.mjs --plan <plan>`
  against your instance's database.

Put it in your environment (never pass a key as a command-line argument):

```bash
export BASEMOUSE_API_KEY=bm_...
# self-hosted only — point the tools at your instance:
export BASEMOUSE_BASE_URL=https://basemouse.your-company.com
```

## 2. Choose how to import your docs

Pick the row that matches where your docs live. This is the step most people
guess wrong: `sync` is tailored to the AI-coding-workspace layout, so if your
docs aren't in that shape, use `import.mjs` instead.

| Your docs are… | Use | Notes |
|---|---|---|
| **Project folders, each with a `CLAUDE.md` / `PROGRESS.md`** (the AI-coding-workspace layout) | `node integrations/cli/basemouse.mjs sync` | Syncs every project under `~/projects` (override with `BASE_DIR`). One project: `sync --single . --slug <name>`. Keep it live: `… watch`. |
| **A folder of Markdown** (`.md`/`.markdown`, optional YAML frontmatter for `title`/`tags`/`type`) | `node scripts/import.mjs ./docs` | The general importer — any Markdown folder, not just CLAUDE.md/PROGRESS.md. |
| **A GitHub repo's agent docs** | the [GitHub Action](../integrations/github-action/action.yml) | Syncs on every push; the key lives once as a repo secret. |
| **Notion / Confluence / PDFs / other non-Markdown** | *(not yet)* | Convert to Markdown first, or talk to us via the [design-partner program](https://basemouse.com/design-partner.html). A corpus-format adapter is on the roadmap. |

> **Why `sync` only picks up CLAUDE.md/PROGRESS.md:** it's built for the
> "one folder per project, agent instructions + progress log" workflow. For
> anything else, `scripts/import.mjs` is the general path — it imports whatever
> Markdown you point it at. Both write into *your* workspace, tagged so agents
> can scope retrieval per project (`tag=project:<slug>`).

All imports are idempotent: re-running is safe (unchanged docs write nothing),
every change is a versioned append-only revision, and empty/oversized files are
reported, not silently dropped.

## 3. Connect your coding tool (MCP)

BaseMouse speaks the Model Context Protocol, so most agent tools connect
natively. Print ready-to-paste config for yours:

```bash
node integrations/cli/basemouse.mjs register            # all supported tools
node integrations/cli/basemouse.mjs register cursor     # just one
```

Supported: `claude`, `cursor`, `windsurf`, `codex`, `gemini`, `grok`, `kiro`,
`antigravity`, `bob` (Bob connects through the `mcp-remote` bridge). Not on
MCP? Call the REST API directly — see [`agent-integration.md`](agent-integration.md).

## 4. Verify it worked

```bash
# a context pack scoped to one project (replace the slug)
curl -s "https://basemouse.com/api/context-pack?tag=project:<slug>&limit=3" \
  -H "Authorization: Bearer $BASEMOUSE_API_KEY" | jq '.entries[] | {id: .citation.id, checksum: .citation.checksum}'
```

You should see your documents' ids and checksums. In your coding tool, ask the
agent to call `get_context_pack` (tag `project:<slug>`) — it will answer from
your docs, with a source on every claim. From there, `search` finds ranked
matches and `upsert_document` lets an agent persist decisions back as durable,
cross-tool memory (see [`agent-integration.md`](agent-integration.md)).
