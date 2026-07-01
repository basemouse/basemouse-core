#!/usr/bin/env python3
"""Slack Socket Mode bot that grounds a local LLM with BaseMouse context packs.

Runtime deps (install in a venv):
  pip install slack-bolt python-dotenv openai httpx

The module keeps import-time side effects tiny so CI can syntax-check it without
Slack credentials or optional dependencies installed.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

try:  # optional at CI/syntax-check time
    import httpx
    from dotenv import load_dotenv
    from openai import OpenAI
    from slack_bolt import App
    from slack_bolt.adapter.socket_mode import SocketModeHandler
except ImportError:  # pragma: no cover - exercised only in dependency-light envs
    httpx = None
    load_dotenv = None
    OpenAI = None
    App = None
    SocketModeHandler = None

LOG = logging.getLogger("basemouse.slack_local_llm")
MENTION_RE = re.compile(r"<@[A-Z0-9]+>")
PROJECT_RE = re.compile(r"(?:^|\s)(?:project|workspace):([A-Za-z0-9_.-]+)", re.IGNORECASE)
COMMAND_RE = re.compile(r"^\s*(?:/basemouse|basemouse)\s+project\s+([A-Za-z0-9_.-]+)\s*$", re.IGNORECASE)

# Shared completion parameters so streaming / non-streaming / tool-calling paths stay in sync.
TEMPERATURE = 0.3
MAX_TOKENS = 2048
RETRIEVAL_MODES = ("always", "auto", "off")
_TRUTHY = {"1", "true", "yes", "on"}

# OpenAI-style function/tool schema the LLM may call in `auto` retrieval mode.
CONTEXT_TOOL = {
    "type": "function",
    "function": {
        "name": "fetch_context_pack",
        "description": (
            "Retrieve grounded BaseMouse context (with citations and checksums) relevant "
            "to a question. Call this when company-, project-, or document-specific knowledge "
            "would improve the answer. Skip it for general questions you can already answer."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query to ground the answer."},
                "workspace": {"type": "string", "description": "Optional project/workspace hint."},
            },
            "required": ["query"],
        },
    },
}


def env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in _TRUTHY


@dataclass(frozen=True)
class Settings:
    slack_bot_token: str
    slack_app_token: str
    llm_base_url: str = "http://localhost:11434/v1"
    llm_model: str = "llama3.2:latest"
    llm_api_key: str = "local"
    system_prompt: str = "You are a helpful technical assistant. Use BaseMouse context when supplied and cite sources."
    basemouse_url: str = "http://localhost:3000"
    basemouse_token: str = ""
    basemouse_limit: int = 5
    request_timeout: float = 15.0
    history_limit: int = 20
    sqlite_path: str = ""
    retrieval_mode: str = "always"
    llm_stream: bool = False
    stream_min_interval: float = 1.2
    thinking_reaction: str = "hourglass_flat"

    @classmethod
    def from_env(cls) -> "Settings":
        if load_dotenv:
            load_dotenv()
        mode = os.getenv("BASEMOUSE_RETRIEVAL_MODE", cls.retrieval_mode).strip().lower()
        if mode not in RETRIEVAL_MODES:
            LOG.warning("invalid_retrieval_mode value=%r; falling back to 'always'", mode)
            mode = "always"
        return cls(
            slack_bot_token=os.getenv("SLACK_BOT_TOKEN", ""),
            slack_app_token=os.getenv("SLACK_APP_TOKEN", ""),
            llm_base_url=os.getenv("LLM_BASE_URL", cls.llm_base_url),
            llm_model=os.getenv("LLM_MODEL", cls.llm_model),
            llm_api_key=os.getenv("LLM_API_KEY", "local"),
            system_prompt=os.getenv("SYSTEM_PROMPT", cls.system_prompt),
            basemouse_url=os.getenv("BASEMOUSE_URL", cls.basemouse_url).rstrip("/"),
            basemouse_token=os.getenv("BASEMOUSE_TOKEN", os.getenv("BASEMOUSE_API_KEY", "")),
            basemouse_limit=int(os.getenv("BASEMOUSE_LIMIT", "5")),
            request_timeout=float(os.getenv("REQUEST_TIMEOUT_SECONDS", "15")),
            history_limit=int(os.getenv("HISTORY_LIMIT", "20")),
            sqlite_path=os.getenv("SQLITE_PATH", ""),
            retrieval_mode=mode,
            llm_stream=env_bool("LLM_STREAM", cls.llm_stream),
            stream_min_interval=float(os.getenv("STREAM_MIN_INTERVAL_SECONDS", "1.2")),
            # Empty string disables the reaction entirely.
            thinking_reaction=os.getenv("THINKING_REACTION", cls.thinking_reaction).strip(),
        )

    def validate(self) -> None:
        missing = []
        if not self.slack_bot_token:
            missing.append("SLACK_BOT_TOKEN")
        if not self.slack_app_token:
            missing.append("SLACK_APP_TOKEN")
        if missing:
            raise SystemExit(f"Missing required environment variables: {', '.join(missing)}")
        if App is None or SocketModeHandler is None or OpenAI is None or httpx is None:
            raise SystemExit("Missing dependencies. Install: pip install slack-bolt python-dotenv openai httpx")


class ConversationStore:
    """Thread/channel history + project mapping with optional SQLite persistence."""

    def __init__(self, sqlite_path: str = "", history_limit: int = 20):
        self.history_limit = history_limit
        self._memory: dict[str, list[dict[str, str]]] = {}
        self._projects: dict[str, str] = {}
        self._db: sqlite3.Connection | None = None
        if sqlite_path:
            Path(sqlite_path).parent.mkdir(parents=True, exist_ok=True)
            self._db = sqlite3.connect(sqlite_path, check_same_thread=False)
            self._db.execute("CREATE TABLE IF NOT EXISTS messages (thread_id TEXT, role TEXT, content TEXT, created_at REAL)")
            self._db.execute("CREATE TABLE IF NOT EXISTS projects (scope_id TEXT PRIMARY KEY, project TEXT, updated_at REAL)")
            self._db.commit()

    def get_history(self, thread_id: str) -> list[dict[str, str]]:
        if self._db:
            rows = self._db.execute(
                "SELECT role, content FROM messages WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
                (thread_id, self.history_limit),
            ).fetchall()
            return [{"role": role, "content": content} for role, content in reversed(rows)]
        return list(self._memory.get(thread_id, []))

    def add_message(self, thread_id: str, role: str, content: str) -> None:
        if self._db:
            self._db.execute(
                "INSERT INTO messages(thread_id, role, content, created_at) VALUES (?, ?, ?, ?)",
                (thread_id, role, content, time.time()),
            )
            self._db.execute(
                "DELETE FROM messages WHERE rowid IN (SELECT rowid FROM messages WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)",
                (thread_id, self.history_limit),
            )
            self._db.commit()
            return
        hist = self._memory.setdefault(thread_id, [])
        hist.append({"role": role, "content": content})
        del hist[:-self.history_limit]

    def set_project(self, scope_id: str, project: str) -> None:
        if self._db:
            self._db.execute(
                "INSERT INTO projects(scope_id, project, updated_at) VALUES (?, ?, ?) ON CONFLICT(scope_id) DO UPDATE SET project=excluded.project, updated_at=excluded.updated_at",
                (scope_id, project, time.time()),
            )
            self._db.commit()
        self._projects[scope_id] = project

    def get_project(self, *scope_ids: str) -> str | None:
        for scope_id in scope_ids:
            if not scope_id:
                continue
            if scope_id in self._projects:
                return self._projects[scope_id]
            if self._db:
                row = self._db.execute("SELECT project FROM projects WHERE scope_id = ?", (scope_id,)).fetchone()
                if row:
                    self._projects[scope_id] = row[0]
                    return row[0]
        return None


def clean_mention(text: str) -> str:
    return MENTION_RE.sub("", text or "").strip()


def extract_inline_project(text: str) -> tuple[str | None, str]:
    match = PROJECT_RE.search(text or "")
    if not match:
        return None, text
    project = match.group(1)
    cleaned = (text[: match.start()] + " " + text[match.end() :]).strip()
    return project, cleaned or text


def format_context_pack(pack: dict[str, Any]) -> str:
    entries = pack.get("entries") or []
    if not entries:
        return "BaseMouse returned no matching context."
    chunks = ["Relevant BaseMouse context (cite labels exactly when used):"]
    for idx, entry in enumerate(entries, start=1):
        citation = (entry.get("citation") or {}).get("label") or f"[{entry.get('id', idx)}]"
        relevance = entry.get("relevance") or {}
        score = relevance.get("score")
        terms = ", ".join(relevance.get("matchedTerms") or [])
        provenance = entry.get("provenance") or {}
        checksum = provenance.get("checksum")
        body = str(entry.get("body") or "").strip()
        if len(body) > 2400:
            body = body[:2400].rstrip() + "…"
        chunks.append(f"\n{citation}\nscore={score}; matched={terms or 'n/a'}; checksum={checksum or 'n/a'}\n{body}")
    citations = pack.get("citations") or []
    chunks.append("\nCitations JSON: " + json.dumps(citations, ensure_ascii=False))
    return "\n".join(chunks)


def fetch_basemouse_context(settings: Settings, query: str, workspace: str | None = None) -> str:
    if not settings.basemouse_url:
        return ""
    params: dict[str, Any] = {"q": query, "limit": settings.basemouse_limit}
    if workspace:
        # Current cloud endpoints scope by API key; self-hosted deployments may
        # also accept workspace/project as a query hint. Safe to omit if unused.
        params["workspace"] = workspace
    headers = {"Accept": "application/json"}
    if settings.basemouse_token:
        headers["Authorization"] = f"Bearer {settings.basemouse_token}"
    try:
        assert httpx is not None
        with httpx.Client(timeout=settings.request_timeout) as client:
            resp = client.get(f"{settings.basemouse_url}/api/context-pack", params=params, headers=headers)
            resp.raise_for_status()
            return format_context_pack(resp.json())
    except Exception as exc:  # keep Slack UX graceful; do not leak tokens
        LOG.exception("basemouse_context_failed")
        return f"BaseMouse context unavailable: {type(exc).__name__}: {exc}"


def build_messages(settings: Settings, history: Iterable[dict[str, str]], user_text: str, context: str) -> list[dict[str, str]]:
    system = settings.system_prompt
    if context:
        system += "\n\n" + context
    return [{"role": "system", "content": system}, *history, {"role": "user", "content": user_text}]


def _safe_json_args(raw: Any) -> dict[str, Any]:
    """Parse a tool-call arguments blob without trusting the model to emit valid JSON."""
    if isinstance(raw, dict):
        return raw
    try:
        parsed = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _assistant_tool_call_message(message: Any) -> dict[str, Any]:
    """Re-serialise an assistant message that carried tool calls so it can be
    appended to the next request. Works with the OpenAI SDK objects and with the
    lightweight fakes used in tests (both expose the same attribute shape)."""
    return {
        "role": "assistant",
        "content": message.content or "",
        "tool_calls": [
            {
                "id": tc.id,
                "type": "function",
                "function": {"name": tc.function.name, "arguments": tc.function.arguments},
            }
            for tc in (message.tool_calls or [])
        ],
    }


def generate(llm: Any, settings: Settings, messages: list[dict[str, Any]]) -> str:
    """Single, non-streaming chat completion."""
    resp = llm.chat.completions.create(
        model=settings.llm_model,
        messages=messages,
        temperature=TEMPERATURE,
        max_tokens=MAX_TOKENS,
    )
    return (resp.choices[0].message.content or "").strip()


def stream_completion(llm: Any, settings: Settings, messages: list[dict[str, Any]], on_delta) -> str:
    """Stream a completion, invoking on_delta(accumulated_text) per chunk.

    Falls back to a single non-streamed completion if the server rejects
    stream=True so callers always get a final answer. Returns the final text.
    """
    try:
        stream = llm.chat.completions.create(
            model=settings.llm_model,
            messages=messages,
            temperature=TEMPERATURE,
            max_tokens=MAX_TOKENS,
            stream=True,
        )
    except Exception:  # server lacks streaming support — degrade to one call
        LOG.warning("streaming_unavailable_falling_back")
        text = generate(llm, settings, messages)
        on_delta(text)
        return text
    parts: list[str] = []
    for chunk in stream:
        if not getattr(chunk, "choices", None):
            continue
        piece = getattr(chunk.choices[0].delta, "content", None)
        if piece:
            parts.append(piece)
            on_delta("".join(parts))
    return "".join(parts).strip()


def run_auto_completion(llm: Any, settings: Settings, messages: list[dict[str, Any]], fetch_fn, max_tool_rounds: int = 2) -> str:
    """`auto` retrieval: expose the BaseMouse tool and let the model decide.

    If the model emits a fetch_context_pack tool call, execute it via fetch_fn
    and call the model again with the tool result. If tool calling is
    unsupported (server raises) or no tool call is made, answer normally.
    fetch_fn(query, workspace) -> str.
    """
    convo = list(messages)
    try:
        resp = llm.chat.completions.create(
            model=settings.llm_model,
            messages=convo,
            tools=[CONTEXT_TOOL],
            tool_choice="auto",
            temperature=TEMPERATURE,
            max_tokens=MAX_TOKENS,
        )
    except Exception:  # server can't do tool calling — fall back to a plain answer
        LOG.warning("tool_calling_unavailable_falling_back")
        return generate(llm, settings, convo)

    for _ in range(max_tool_rounds):
        message = resp.choices[0].message
        tool_calls = getattr(message, "tool_calls", None)
        if not tool_calls:
            return (message.content or "").strip()
        convo.append(_assistant_tool_call_message(message))
        for tc in tool_calls:
            args = _safe_json_args(tc.function.arguments)
            result = fetch_fn(args.get("query", ""), args.get("workspace"))
            convo.append({"role": "tool", "tool_call_id": tc.id, "content": result})
        resp = llm.chat.completions.create(
            model=settings.llm_model,
            messages=convo,
            tools=[CONTEXT_TOOL],
            tool_choice="auto",
            temperature=TEMPERATURE,
            max_tokens=MAX_TOKENS,
        )

    # Exhausted the tool-call budget; force a final textual answer without tools.
    return generate(llm, settings, convo)


def create_bot(settings: Settings):
    settings.validate()
    assert App is not None and OpenAI is not None
    app = App(token=settings.slack_bot_token)
    llm = OpenAI(base_url=settings.llm_base_url, api_key=settings.llm_api_key)
    store = ConversationStore(settings.sqlite_path, settings.history_limit)

    def compute_answer(thread_id: str, channel: str, user_text: str, sink) -> str:
        """Resolve project, run the configured retrieval mode, and emit the answer.

        `sink(messages)` posts/streams the final answer to Slack and returns the
        text actually delivered. Keeping I/O behind `sink` lets the retrieval
        logic stay free of Slack specifics.
        """
        explicit_project, cleaned = extract_inline_project(user_text)
        if explicit_project:
            store.set_project(thread_id, explicit_project)
        project = explicit_project or store.get_project(thread_id, channel)

        def fetch_fn(query: str, workspace: str | None = None) -> str:
            return fetch_basemouse_context(settings, query, workspace or project)

        history = store.get_history(thread_id)
        if settings.retrieval_mode == "auto":
            # Let the model decide whether to fetch context. Streaming is not
            # combined with the tool-call loop to keep that path simple.
            messages = build_messages(settings, history, cleaned, "")
            content = run_auto_completion(llm, settings, messages, fetch_fn)
            sink(text=content or "(no response)")
        else:
            context = "" if settings.retrieval_mode == "off" else fetch_fn(cleaned)
            messages = build_messages(settings, history, cleaned, context)
            content = sink(messages=messages)

        store.add_message(thread_id, "user", cleaned)
        store.add_message(thread_id, "assistant", content)
        return content

    def make_sink(say, client, reply_thread_ts):
        """Build the answer sink for a handler: streams when enabled, else posts once.

        `reply_thread_ts` is the Slack thread to reply in (None posts to the
        channel root, e.g. a non-threaded DM) — distinct from the history scope id.
        """

        def sink(messages=None, text=None):
            if messages is None:  # caller already has the final text (auto mode)
                say(text=text, thread_ts=reply_thread_ts)
                return text
            if settings.llm_stream and client is not None:
                return _stream_to_slack(say, client, reply_thread_ts, messages)
            content = generate(llm, settings, messages)
            say(text=content or "(no response)", thread_ts=reply_thread_ts)
            return content

        return sink

    def _stream_to_slack(say, client, thread_ts, messages) -> str:
        """Post a placeholder, then update it on a throttled cadence as tokens arrive."""
        posted = say(text="…", thread_ts=thread_ts) or {}
        ch = posted.get("channel")
        ts = posted.get("ts")
        state = {"last": 0.0}

        def on_delta(accumulated: str) -> None:
            now = time.monotonic()
            if not (ch and ts) or now - state["last"] < settings.stream_min_interval:
                return
            state["last"] = now
            try:
                client.chat_update(channel=ch, ts=ts, text=accumulated + " ▌")
            except Exception:  # rate limited / transient — the final update will catch up
                LOG.warning("chat_update_skipped")

        final = stream_completion(llm, settings, messages, on_delta)
        final_text = final or "(no response)"
        if ch and ts:
            try:
                client.chat_update(channel=ch, ts=ts, text=final_text)
                return final
            except Exception:  # could not edit the placeholder — post the answer fresh
                LOG.warning("final_chat_update_failed_posting_new")
        say(text=final_text, thread_ts=thread_ts)
        return final

    def add_reaction(client, channel: str, ts: str):
        """Add the thinking reaction; returns a remover callable (no-op on failure)."""
        name = settings.thinking_reaction
        if not (client and name and channel and ts):
            return lambda: None
        try:
            client.reactions_add(channel=channel, timestamp=ts, name=name)
        except Exception:  # missing reactions:write scope, already reacted, etc.
            LOG.warning("reaction_add_failed")
            return lambda: None

        def remove():
            try:
                client.reactions_remove(channel=channel, timestamp=ts, name=name)
            except Exception:
                LOG.warning("reaction_remove_failed")

        return remove

    def maybe_project_command(text: str, scope_id: str) -> str | None:
        match = COMMAND_RE.match(text or "")
        if not match:
            return None
        project = match.group(1)
        store.set_project(scope_id, project)
        return f"BaseMouse project for this thread/channel is now `{project}`."

    @app.event("app_mention")
    def handle_mention(event, say, client):  # type: ignore[no-untyped-def]
        thread_id = event.get("thread_ts") or event["ts"]
        channel = event.get("channel", "")
        text = clean_mention(event.get("text", ""))
        if not text:
            return
        if command_reply := maybe_project_command(text, thread_id):
            return say(text=command_reply, thread_ts=thread_id)
        remove_reaction = add_reaction(client, channel, event.get("ts"))
        try:
            compute_answer(thread_id, channel, text, make_sink(say, client, thread_id))
        except Exception as exc:
            LOG.exception("slack_answer_failed")
            say(text=f"Sorry — I hit an error: {type(exc).__name__}", thread_ts=thread_id)
        finally:
            remove_reaction()

    @app.event("message")
    def handle_dm(event, say, client):  # type: ignore[no-untyped-def]
        # Drop anything posted by a bot (including our own replies, which Slack
        # redelivers as message.im events carrying a bot_id but no subtype) so
        # the connector never answers itself in a DM loop.
        if event.get("bot_id") or event.get("subtype") == "bot_message" or event.get("channel_type") != "im":
            return
        channel = event.get("channel", "")
        thread_id = event.get("thread_ts") or channel
        text = event.get("text", "").strip()
        if not text:
            return
        if command_reply := maybe_project_command(text, thread_id):
            return say(text=command_reply, thread_ts=event.get("thread_ts"))
        remove_reaction = add_reaction(client, channel, event.get("ts"))
        try:
            compute_answer(thread_id, channel, text, make_sink(say, client, event.get("thread_ts")))
        except Exception as exc:
            LOG.exception("dm_answer_failed")
            say(text=f"Sorry — I hit an error: {type(exc).__name__}", thread_ts=event.get("thread_ts"))
        finally:
            remove_reaction()

    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="Run BaseMouse Slack + local LLM connector")
    parser.add_argument("--log-level", default=os.getenv("LOG_LEVEL", "INFO"))
    args = parser.parse_args()
    logging.basicConfig(level=getattr(logging, args.log_level.upper(), logging.INFO))
    settings = Settings.from_env()
    app = create_bot(settings)
    assert SocketModeHandler is not None
    LOG.info(
        "Starting Slack connector | llm=%s model=%s basemouse=%s retrieval=%s stream=%s",
        settings.llm_base_url, settings.llm_model, settings.basemouse_url,
        settings.retrieval_mode, settings.llm_stream,
    )
    SocketModeHandler(app, settings.slack_app_token).start()


if __name__ == "__main__":
    main()
