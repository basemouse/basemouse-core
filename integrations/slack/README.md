# BaseMouse Slack + Local LLM Connector

This connector lets a Slack workspace talk to a local/OpenAI-compatible LLM while grounding answers with BaseMouse `/api/context-pack` citations.

```text
Slack (mentions / DMs / threads)
  -> Python Slack Bolt app over Socket Mode (outbound WebSocket only)
  -> local LLM endpoint (Ollama, vLLM, LM Studio)
  -> BaseMouse context-pack API (cloud or internal self-hosted)
```

## Slack app setup

1. Create a Slack app and enable **Socket Mode**.
2. Add an app-level token with `connections:write`; put it in `SLACK_APP_TOKEN` (`xapp-...`).
3. Add bot scopes:
   - `app_mentions:read`
   - `chat:write`
   - `im:history`
   - `im:read`
   - `im:write`
   - `reactions:write` (only needed for the "thinking" reaction; the bot
     degrades gracefully if it is missing)
4. Subscribe to bot events:
   - `app_mention`
   - `message.im`
5. Install the app to your workspace and copy the bot token to `SLACK_BOT_TOKEN` (`xoxb-...`).

Socket Mode means no public URL or inbound port is required.

## Install

Use a venv so the main BaseMouse app stays zero-dependency:

```bash
cd integrations/slack
python3 -m venv .venv
. .venv/bin/activate
pip install slack-bolt python-dotenv openai httpx
cp .env.example .env
```

Edit `.env` for your local LLM and BaseMouse endpoint.

### Ollama example

```bash
ollama serve
ollama pull llama3.2
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=llama3.2:latest
LLM_API_KEY=local
```

### vLLM / LM Studio

Point `LLM_BASE_URL` at the OpenAI-compatible `/v1` base URL and set `LLM_MODEL` to the served model name.

## BaseMouse grounding

Set:

```env
BASEMOUSE_URL=https://basemouse.com        # or http://basemouse.internal:3000
BASEMOUSE_TOKEN=bm_...
BASEMOUSE_LIMIT=5
```

For every user message, the bot fetches `/api/context-pack?q=...`, formats entries with citations/checksums, and injects them into the system prompt. If BaseMouse is temporarily unavailable, the bot still answers and reports the context error without exposing tokens.

### Retrieval modes

`BASEMOUSE_RETRIEVAL_MODE` controls how context is pulled:

| Mode     | Behaviour |
|----------|-----------|
| `always` | Fetch a context pack for every message and inject it into the system prompt (default; preserves prior behaviour). |
| `auto`   | Expose a `fetch_context_pack` tool to the LLM via OpenAI tools/function calling. If the model emits a tool call, the bot executes the BaseMouse fetch and calls the model again with the tool result. If the server can't do tool calling, or the model makes no tool call, it answers normally. |
| `off`    | Never call BaseMouse; the LLM answers from the prompt/history alone. |

`auto` needs a tool-calling-capable model and OpenAI-compatible server. The bot caps tool rounds (default 2) and always falls back to a plain completion, so an unsupported server never breaks the reply.

## Thinking reaction

While processing a mention or DM the bot adds an emoji reaction (default `hourglass_flat`) to the user's message and removes it when the answer is posted. This needs the `reactions:write` scope. If Slack denies the reaction (missing scope, already reacted, etc.) the bot logs a warning and continues — the answer is never blocked. Set `THINKING_REACTION=` (empty) to disable.

## Streaming

Set `LLM_STREAM=true` to stream the answer into Slack. The bot posts a placeholder, then edits it via `chat.update` on a throttled cadence (`STREAM_MIN_INTERVAL_SECONDS`, default 1.2s) to stay clear of Slack rate limits. If the OpenAI-compatible server doesn't support `stream=True`, or an edit fails, it falls back to posting the final answer. Non-streaming (a single post) remains the default. Streaming is not combined with `auto` retrieval (the tool-call loop posts its final answer in one shot).

## Projects / workspaces

Current BaseMouse cloud scoping is primarily API-key based. The bot also supports lightweight project hints for local/self-hosted deployments:

- Inline: `project:alpha what is our release policy?`
- Thread/DM command: `basemouse project alpha` or `/basemouse project alpha`

The mapping is stored in memory, or in SQLite if `SQLITE_PATH` is set.

## Run

```bash
cd integrations/slack
. .venv/bin/activate
python slack_local_llm.py
```

## CI-friendly checks

The connector is intentionally import-light. Syntax check it without installing Slack dependencies:

```bash
python3 -m py_compile integrations/slack/slack_local_llm.py
```

Unit tests cover the pure helpers plus the streaming, tool-calling, and retrieval flows using stdlib `unittest` and fakes — no Slack/OpenAI/httpx install required:

```bash
cd integrations/slack && python3 -m unittest test_slack_local_llm
```

## Security notes

- Keep Slack, BaseMouse, and LLM tokens out of logs.
- Prefer internal DNS or private networking for self-hosted BaseMouse and local LLM endpoints.
- Use BaseMouse API keys with least-privilege workspaces/plans where possible.
- Socket Mode still requires outbound HTTPS/WebSocket access to Slack.
