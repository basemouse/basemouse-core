"""Lightweight BaseMouse API client using only the Python standard library."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Mapping


class BaseMouseAPIError(RuntimeError):
    def __init__(self, message: str, *, status: int | None = None, body: Any = None, url: str | None = None):
        super().__init__(message)
        self.status = status
        self.body = body
        self.url = url


@dataclass
class BaseMouseClient:
    base_url: str = os.getenv("BASEMOUSE_URL", "https://basemouse.com")
    api_key: str = os.getenv("BASEMOUSE_API_KEY", os.getenv("BASEMOUSE_TOKEN", ""))
    timeout: float = 15.0

    def __post_init__(self) -> None:
        self.base_url = self.base_url.rstrip("/")

    def request(self, path: str, *, method: str = "GET", query: Mapping[str, Any] | None = None, body: Any = None) -> Any:
        url = self.base_url + path
        params = {k: str(v) for k, v in (query or {}).items() if v is not None and v != ""}
        if params:
            url += "?" + urllib.parse.urlencode(params)
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {"Accept": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:  # nosec B310: caller controls BaseMouse URL intentionally
                text = res.read().decode("utf-8")
                return json.loads(text) if text else None
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            try:
                parsed = json.loads(raw) if raw else None
            except json.JSONDecodeError:
                parsed = raw
            message = parsed.get("message") or parsed.get("error") if isinstance(parsed, dict) else str(parsed)
            raise BaseMouseAPIError(message or f"BaseMouse request failed with {exc.code}", status=exc.code, body=parsed, url=url) from exc
        except Exception as exc:  # network, timeout, JSON decode
            raise BaseMouseAPIError(str(exc), url=url) from exc

    def search(self, q: str, *, type: str | None = None, tag: str | None = None, retrieval: str | None = None, mode: str | None = None) -> Any:
        # `retrieval` picks the ranking mode ("lexical" default, "hybrid" for
        # graph-aware expansion); `mode` is accepted as an alias.
        return self.request("/api/search", query={"q": q, "type": type, "tag": tag, "retrieval": retrieval if retrieval is not None else mode})

    def context_pack(self, q: str | None = None, *, limit: int | None = None, type: str | None = None, tag: str | None = None, workspace: str | None = None, retrieval: str | None = None, mode: str | None = None) -> Any:
        return self.request("/api/context-pack", query={"q": q, "limit": limit, "type": type, "tag": tag, "workspace": workspace, "retrieval": retrieval if retrieval is not None else mode})

    def list_repository(self, *, limit: int | None = None, offset: int | None = None) -> Any:
        return self.request("/api/repository", query={"limit": limit, "offset": offset})

    def create_document(self, document: Mapping[str, Any]) -> Any:
        return self.request("/api/documents", method="POST", body=dict(document))

    def update_document(self, doc_id: str, fields: Mapping[str, Any], *, expected_version: int | None = None) -> Any:
        body = dict(fields)
        if expected_version is not None:
            body["expectedVersion"] = expected_version
        return self.request(f"/api/documents/{urllib.parse.quote(doc_id, safe='')}", method="PUT", body=body)

    def delete_document(self, doc_id: str) -> Any:
        return self.request(f"/api/documents/{urllib.parse.quote(doc_id, safe='')}", method="DELETE")

    def document_history(self, doc_id: str) -> Any:
        return self.request(f"/api/documents/{urllib.parse.quote(doc_id, safe='')}/history")

    def usage(self) -> Any:
        return self.request("/api/usage")

    def rotate_key(self) -> Any:
        return self.request("/api/keys/rotate", method="POST")


def format_context_pack_for_prompt(pack: Mapping[str, Any]) -> str:
    entries = pack.get("entries") or []
    if not entries:
        return "BaseMouse context: no matching entries."
    lines = ["BaseMouse context (cite labels when used):"]
    for entry in entries:
        citation = entry.get("citation") or {}
        provenance = entry.get("provenance") or {}
        relevance = entry.get("relevance") or {}
        label = citation.get("label") or f"[{entry.get('id')}] {entry.get('title')}"
        lines.append(f"\n{label}\nscore={relevance.get('score', 'n/a')}; checksum={provenance.get('checksum', 'n/a')}\n{entry.get('body', '')}")
    return "\n".join(lines)
