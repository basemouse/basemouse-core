#!/usr/bin/env python3
"""Unit tests for the BaseMouse Slack connector's pure helpers and LLM flows.

These exercise the streaming, tool-calling, and retrieval logic without any
Slack, OpenAI, or httpx dependencies installed — everything is driven by small
fakes that mimic the OpenAI SDK's object shape.

Run with:
    python3 -m unittest integrations/slack/test_slack_local_llm.py
or:
    cd integrations/slack && python3 -m unittest test_slack_local_llm
"""

import os
import sys
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import slack_local_llm as mod  # noqa: E402


# --- Fakes mimicking the OpenAI SDK response shapes ------------------------

def msg_response(content=None, tool_calls=None):
    message = SimpleNamespace(content=content, tool_calls=tool_calls)
    return SimpleNamespace(choices=[SimpleNamespace(message=message)])


def tool_call(call_id, name, arguments):
    return SimpleNamespace(id=call_id, function=SimpleNamespace(name=name, arguments=arguments))


def chunk(content):
    return SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=content))])


class FakeCompletions:
    """Returns scripted responses in order; raises if a response is an Exception."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        resp = self.responses.pop(0)
        if isinstance(resp, Exception):
            raise resp
        return resp


class FakeLLM:
    def __init__(self, responses):
        self.chat = SimpleNamespace(completions=FakeCompletions(responses))

    @property
    def calls(self):
        return self.chat.completions.calls


def settings(**overrides):
    base = dict(slack_bot_token="x", slack_app_token="y")
    base.update(overrides)
    return mod.Settings(**base)


# --- Pure helpers ----------------------------------------------------------

class HelperTest(unittest.TestCase):
    def test_clean_mention(self):
        self.assertEqual(mod.clean_mention("<@U123> hello there"), "hello there")
        self.assertEqual(mod.clean_mention(""), "")

    def test_extract_inline_project(self):
        proj, cleaned = mod.extract_inline_project("project:alpha what is policy?")
        self.assertEqual(proj, "alpha")
        self.assertEqual(cleaned, "what is policy?")

    def test_extract_inline_project_none(self):
        proj, cleaned = mod.extract_inline_project("just a question")
        self.assertIsNone(proj)
        self.assertEqual(cleaned, "just a question")

    def test_format_context_pack_empty(self):
        self.assertIn("no matching context", mod.format_context_pack({"entries": []}))

    def test_format_context_pack_entries(self):
        out = mod.format_context_pack({
            "entries": [{"body": "Body text", "citation": {"label": "[a] Alpha"},
                         "relevance": {"score": 0.9, "matchedTerms": ["x"]},
                         "provenance": {"checksum": "abc"}}],
            "citations": ["[a]"]},
        )
        self.assertIn("[a] Alpha", out)
        self.assertIn("Body text", out)
        self.assertIn("checksum=abc", out)

    def test_build_messages_injects_context(self):
        msgs = mod.build_messages(settings(), [{"role": "user", "content": "prev"}], "hi", "CTX")
        self.assertEqual(msgs[0]["role"], "system")
        self.assertIn("CTX", msgs[0]["content"])
        self.assertEqual(msgs[-1], {"role": "user", "content": "hi"})

    def test_env_bool(self):
        os.environ["BM_TEST_FLAG"] = "TRUE"
        self.assertTrue(mod.env_bool("BM_TEST_FLAG"))
        os.environ["BM_TEST_FLAG"] = "no"
        self.assertFalse(mod.env_bool("BM_TEST_FLAG"))
        del os.environ["BM_TEST_FLAG"]
        self.assertFalse(mod.env_bool("BM_TEST_FLAG"))
        self.assertTrue(mod.env_bool("BM_TEST_FLAG", default=True))

    def test_safe_json_args(self):
        self.assertEqual(mod._safe_json_args('{"query": "q"}'), {"query": "q"})
        self.assertEqual(mod._safe_json_args("not json"), {})
        self.assertEqual(mod._safe_json_args(None), {})
        self.assertEqual(mod._safe_json_args({"query": "q"}), {"query": "q"})
        self.assertEqual(mod._safe_json_args("[1,2]"), {})  # non-dict JSON

    def test_assistant_tool_call_message(self):
        msg = SimpleNamespace(content=None, tool_calls=[tool_call("c1", "fetch_context_pack", '{"query":"q"}')])
        out = mod._assistant_tool_call_message(msg)
        self.assertEqual(out["role"], "assistant")
        self.assertEqual(out["tool_calls"][0]["id"], "c1")
        self.assertEqual(out["tool_calls"][0]["function"]["name"], "fetch_context_pack")


class SettingsEnvTest(unittest.TestCase):
    def setUp(self):
        # Drop any preset env that would override defaults under test.
        for k in ("BASEMOUSE_RETRIEVAL_MODE", "LLM_STREAM", "THINKING_REACTION", "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"):
            os.environ.pop(k, None)

    def test_defaults(self):
        s = mod.Settings.from_env()
        self.assertEqual(s.retrieval_mode, "always")
        self.assertFalse(s.llm_stream)
        self.assertEqual(s.thinking_reaction, "hourglass_flat")

    def test_invalid_mode_falls_back(self):
        os.environ["BASEMOUSE_RETRIEVAL_MODE"] = "bogus"
        self.assertEqual(mod.Settings.from_env().retrieval_mode, "always")
        os.environ.pop("BASEMOUSE_RETRIEVAL_MODE")

    def test_modes_and_stream(self):
        os.environ["BASEMOUSE_RETRIEVAL_MODE"] = "AUTO"
        os.environ["LLM_STREAM"] = "1"
        s = mod.Settings.from_env()
        self.assertEqual(s.retrieval_mode, "auto")
        self.assertTrue(s.llm_stream)
        os.environ.pop("BASEMOUSE_RETRIEVAL_MODE")
        os.environ.pop("LLM_STREAM")


# --- Completion engine -----------------------------------------------------

class GenerateTest(unittest.TestCase):
    def test_generate(self):
        llm = FakeLLM([msg_response("the answer")])
        self.assertEqual(mod.generate(llm, settings(), [{"role": "user", "content": "q"}]), "the answer")


class StreamTest(unittest.TestCase):
    def test_stream_accumulates_and_reports(self):
        llm = FakeLLM([[chunk("Hel"), chunk("lo"), chunk(" world")]])
        seen = []
        final = mod.stream_completion(llm, settings(), [{"role": "user", "content": "q"}], seen.append)
        self.assertEqual(final, "Hello world")
        self.assertEqual(seen[-1], "Hello world")
        self.assertEqual(seen[0], "Hel")
        # Confirm we asked for a streamed completion.
        self.assertTrue(llm.calls[0]["stream"])

    def test_stream_fallback_when_unsupported(self):
        llm = FakeLLM([TypeError("stream not supported"), msg_response("final answer")])
        seen = []
        final = mod.stream_completion(llm, settings(), [{"role": "user", "content": "q"}], seen.append)
        self.assertEqual(final, "final answer")
        self.assertEqual(seen, ["final answer"])
        # Second (fallback) call must NOT request streaming.
        self.assertNotIn("stream", llm.calls[1])


class AutoCompletionTest(unittest.TestCase):
    def test_executes_tool_call_then_answers(self):
        llm = FakeLLM([
            msg_response(tool_calls=[tool_call("c1", "fetch_context_pack", '{"query":"release policy"}')]),
            msg_response("grounded answer"),
        ])
        fetched = []

        def fetch_fn(query, workspace=None):
            fetched.append((query, workspace))
            return "CONTEXT PACK"

        out = mod.run_auto_completion(llm, settings(), [{"role": "user", "content": "q"}], fetch_fn)
        self.assertEqual(out, "grounded answer")
        self.assertEqual(fetched, [("release policy", None)])
        # The second request should carry the tool result message.
        second_msgs = llm.calls[1]["messages"]
        self.assertTrue(any(m.get("role") == "tool" and m.get("content") == "CONTEXT PACK" for m in second_msgs))

    def test_no_tool_call_answers_directly(self):
        llm = FakeLLM([msg_response("direct answer")])
        called = []
        out = mod.run_auto_completion(llm, settings(), [{"role": "user", "content": "q"}],
                                      lambda q, w=None: called.append(q) or "x")
        self.assertEqual(out, "direct answer")
        self.assertEqual(called, [])

    def test_tool_calling_unsupported_falls_back(self):
        # First call (with tools) raises; fallback generate() returns text.
        llm = FakeLLM([TypeError("tools unsupported"), msg_response("plain answer")])
        out = mod.run_auto_completion(llm, settings(), [{"role": "user", "content": "q"}], lambda q, w=None: "x")
        self.assertEqual(out, "plain answer")
        self.assertNotIn("tools", llm.calls[1])

    def test_tool_round_budget_exhausted(self):
        # Model keeps requesting tools; after budget we force a plain answer.
        loop_resp = msg_response(tool_calls=[tool_call("c1", "fetch_context_pack", '{"query":"q"}')])
        llm = FakeLLM([loop_resp, loop_resp, loop_resp, msg_response("forced final")])
        out = mod.run_auto_completion(llm, settings(), [{"role": "user", "content": "q"}],
                                      lambda q, w=None: "CTX", max_tool_rounds=2)
        self.assertEqual(out, "forced final")


# --- ConversationStore -----------------------------------------------------

class StoreTest(unittest.TestCase):
    def test_memory_history_and_project(self):
        store = mod.ConversationStore(history_limit=3)
        for i in range(5):
            store.add_message("t1", "user", f"m{i}")
        hist = store.get_history("t1")
        self.assertEqual(len(hist), 3)
        self.assertEqual(hist[-1]["content"], "m4")
        store.set_project("t1", "alpha")
        self.assertEqual(store.get_project("nope", "t1"), "alpha")
        self.assertIsNone(store.get_project("unknown"))


if __name__ == "__main__":
    unittest.main()
