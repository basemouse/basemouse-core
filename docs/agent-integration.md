# Agent Integration

A BaseMouse context pack is a single JSON payload of grounded project documents that an agent can drop straight into a prompt. You fetch it, render it into your model turn, and let the model answer using cited, provenance-stamped entries instead of guessing.

## Fetch a context pack

BaseMouse exposes two read endpoints (`basemouse.com`, or `http://localhost:3000` in dev):

```
GET /api/context-pack?q=<query>&limit=<n>&type=<type>&tag=<tag>
GET /api/search?q=<query>
```

curl:

```bash
curl "https://basemouse.com/api/context-pack?q=agent%20context&limit=3"
```

Node (zero dependencies, built-in fetch):

```js
async function getContextPack(query, limit = 3) {
  const url = new URL("https://basemouse.com/api/context-pack");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`context-pack ${res.status}`);
  return res.json(); // basemouse.context_pack.v1
}

const pack = await getContextPack("agent context", 3);
console.log(pack.entryCount, "of", pack.totalMatches, "matches");
```

Retrieval is lexical keyword scoring by default, so `relevance.score` and `relevance.matchedTerms` tell you why each entry matched; pass `retrieval=hybrid` to blend in one-hop graph expansion and local vector similarity (each result then explains its per-signal contribution). Use `type` and `tag` to narrow — `tag=project:<slug>` scopes a pack to one project. When `truncated` is `true`, `totalMatches` exceeds what you received, so raise `limit` or refine `q` if you need more.

## Or skip the HTTP glue: connect over MCP

If your agent runtime speaks the Model Context Protocol (Claude Code, Cursor,
Windsurf, Codex CLI, Gemini CLI, Grok CLI, AWS Kiro, Google Antigravity, and
most agent frameworks via an MCP client — plus SSE-only clients like IBM Bob
through the `mcp-remote` stdio bridge, which `basemouse register bob` prints),
you don't need to hand-roll the fetch at all: BaseMouse serves the same
capabilities as MCP tools — `search`, `get_context_pack`, and
`upsert_document` (a write tool: agents persist decisions or session context
by stable id, idempotently — unchanged content writes nothing and every real
change lands in the append-only history) — at
`POST https://basemouse.com/mcp` (stateless JSON-RPC over Streamable HTTP),
with the same auth, scoping, and quota metering as REST. Claude Code:

```bash
claude mcp add --scope user --transport http basemouse https://basemouse.com/mcp \
  --header "Authorization: Bearer bm_..."
```

For other tools, `node integrations/cli/basemouse.mjs register` prints
ready-to-paste config per client. Omit the auth header to browse the public
demo corpus. Everything below (prompt templates, citation rules, governance)
applies identically — an MCP `get_context_pack` call returns the same
`basemouse.context_pack.v1` JSON.

## Cross-tool memory: write in one agent, read in another

Because context lives in BaseMouse — not in any single tool — an agent in one
client can persist a decision and an agent in a **different** client (different
vendor, no shared session or history) reads it back on its next pull. That is
the seamless part of switching tools: your project docs *and* anything an agent
wrote back travel with you; only the live chat transcript stays local to each
tool.

The round trip, tool-agnostic:

```text
Agent A (e.g. Grok):   upsert_document  id="release-plan"
                       body="Rollback codeword ZEBRA-9; ship Thursday."
                       → outcome "created", version 1

Agent B (e.g. Gemini): get_context_pack  tag / query for "release-plan"
                       → reads back "Rollback codeword ZEBRA-9; ship Thursday."
```

Same thing over REST if a client isn't MCP-native (write with either agent's
key, read with the other's — both scoped to the same workspace):

```bash
# Agent A persists a decision (idempotent: unchanged content writes nothing)
curl -s -X PUT "https://basemouse.com/api/documents/release-plan?mode=upsert" \
  -H "Authorization: Bearer $BASEMOUSE_API_KEY" -H "Content-Type: application/json" \
  -d '{"title":"Release plan","body":"Rollback codeword ZEBRA-9; ship Thursday.","tags":["release"]}'
# → {"outcome":"created","document":{"version":1,...}}

# Agent B (any other tool, same workspace) reads it back, grounded and cited
curl -s "https://basemouse.com/api/context-pack?q=rollback+codeword&limit=3" \
  -H "Authorization: Bearer $BASEMOUSE_API_KEY"
# → a pack whose entries include the release-plan decision, with a checksum
```

Every write is a versioned, append-only revision, so this doubles as durable
memory across sessions and machines — re-running the write with identical
content is a no-op (`outcome:"unchanged"`, no new revision), and every real
change is preserved in history. Writes require an authenticated `bm_` key with
write access; anonymous callers can read the public demo corpus but not write.

## System prompt template

```text
You are answering using BaseMouse project context provided in the user message.

Rules:
- Treat each entry as grounded BaseMouse context. Do not invent facts beyond it.
- Cite every supporting fact using the entry's citation.label, or its id if no label is given.
- When entries conflict, prefer the one with the higher relevance.score, then the more recent provenance.updatedAt.
- Before treating a claim as authoritative, verify it against the entry's provenance.checksum.
- Use relationships and each entry.related list to see how documents connect, and follow them to decide what to retrieve next.
- If the task needs context that is not in the pack, say so and ask for a repository search or a larger context pack.
```

## User prompt template

Render the pack into the user turn, one block per entry:

```text
TASK: {{TASK}}

BaseMouse context pack (query: {{pack.query}}, {{pack.entryCount}} of {{pack.totalMatches}} entries):

{{#each entries}}
[{{citation.label}}]
{{body}}
(checksum: {{provenance.checksum}})

{{/each}}
```

Plain Node version of the loop:

```js
const rendered = pack.entries
  .map((e) => `[${e.citation.label}]\n${e.body}\n(checksum: ${e.provenance.checksum})`)
  .join("\n\n");
```

## Wiring it into your framework

- **CrewAI**: fetch the pack inside a custom tool's `_run`, return the rendered string as the tool result so the agent reads it as an observation.
- **LangGraph**: put `getContextPack` in a retriever node, write the rendered entries to graph state, and feed that state into the model node downstream.
- **AutoGen**: prepend the rendered pack to the system or first user message before kicking off the agent conversation.
- **Custom agents**: call the endpoint directly, render with the loop above, and inject as system context or a user-turn block. The `agentInstructions` array in the response mirrors the system rules, so you can splice it in verbatim.

## Governance and audit

Every `/api/context-pack` call also emits a standard OpenTelemetry span named `basemouse.context_pack` over OTLP/HTTP JSON to MeshAI at `https://api.meshai.dev/api/v1/ingest/v1/traces`. The span carries evidence only (query, entry_count, total_matches, truncated, filters, and document ids) and never document bodies, so retrieval stays auditable without leaking content. BaseMouse is the context substrate that grounds the agent, and MeshAI is the control plane that observes and audits which context each agent pulled. The emission is vendor-neutral OTLP, so any OpenTelemetry backend works.
