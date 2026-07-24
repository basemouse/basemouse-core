#!/usr/bin/env bash
#
# basemouse-integration.sh
#
# DEPRECATED: superseded by the cross-platform Node CLI at
# integrations/cli/basemouse.mjs (`sync` / `watch` / `register` subcommands —
# works on Windows/macOS/Linux with no bash/curl/jq, and registers MCP for
# Cursor/Windsurf/Codex/Gemini as well as Claude Code). This script still
# works but only receives fixes, not features.
#
# Wires BaseMouse (basemouse.com / basemouse-core) into the ~/projects
# workspace from setup-projects.sh as the shared, versioned, cross-machine
# context layer for Claude Code.
#
# What this does:
#   1. Import every project's CLAUDE.md + PROGRESS.md as BaseMouse documents,
#      tagged `project:<slug>` -- re-run any time to push updates (each write
#      is versioned/append-only on the BaseMouse side, nothing is lost)
#   2. Print the one-time `claude mcp add` command to register BaseMouse as
#      a native MCP tool so any Claude Code session, on any machine, can
#      call search / get_context_pack scoped to the current project
#   3. Print the CLAUDE.md snippet to drop into each project so agents know
#      the context is there and how to pull it
#
# Prereqs:
#   - BASEMOUSE_BASE_URL   defaults to https://basemouse.com; override for a
#                          self-hosted instance (e.g. http://localhost:3000)
#   - BASEMOUSE_API_KEY    bm_... (from https://basemouse.com/#pricing, or
#                          scripts/issue-key.mjs on a self-hosted instance)
#   - curl, jq
#
# Usage:
#   BASEMOUSE_API_KEY=bm_xxx ./basemouse-integration.sh

set -euo pipefail

BASE_DIR="${BASE_DIR:-$HOME/projects}"
BASEMOUSE_BASE_URL="${BASEMOUSE_BASE_URL:-https://basemouse.com}"
BASEMOUSE_API_KEY="${BASEMOUSE_API_KEY:?set BASEMOUSE_API_KEY -- get one at https://basemouse.com/#pricing (shown once, save it)}"

RESP="$(mktemp)"
trap 'rm -f "$RESP"' EXIT

echo "== Step 0: using the real hosted basemouse.com =="
cat <<'EOF'
This defaults to the actual hosted product (https://basemouse.com), so you're
dogfooding what a paying customer gets -- not just the self-hosted open-core
engine.

Get a key: go to https://basemouse.com/#pricing, pick a plan, pay via Stripe.
The key (bm_...) is shown exactly once -- save it immediately.

  BASEMOUSE_API_KEY=bm_xxx ./basemouse-integration.sh

To use your own self-hosted instance instead (e.g. for a project you don't
want leaving your infra), override BASEMOUSE_BASE_URL:

  BASEMOUSE_BASE_URL=http://localhost:3000 BASEMOUSE_API_KEY=bm_xxx \
    ./basemouse-integration.sh
EOF
echo

echo "== Step 1: importing project docs, tagged by project =="
for dir in "$BASE_DIR"/*/; do
  # Document ids and the `project:<slug>` tag must be lowercase a-z0-9-, so
  # normalize the folder name: lowercase, collapse every other run to a single
  # hyphen, and trim stray leading/trailing hyphens.
  slug="$(basename "$dir")"
  slug="$(printf '%s' "$slug" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-')"
  slug="${slug#-}"; slug="${slug%-}"
  [ -n "$slug" ] || continue

  for f in CLAUDE.md PROGRESS.md; do
    filepath="$dir$f"
    [ -f "$filepath" ] || continue

    doc_id="${slug}-$(printf '%s' "$f" | tr '[:upper:]' '[:lower:]' | tr '.' '-')"   # e.g. meshai-claude-md
    title="$slug — $f"
    body="$(cat "$filepath")"

    payload=$(jq -n \
      --arg id "$doc_id" \
      --arg title "$title" \
      --arg body "$body" \
      --arg tag "project:$slug" \
      '{id: $id, title: $title, body: $body, type: "note", tags: [$tag]}')

    # Try to create. A duplicate id returns 409 -- fall back to a versioned update.
    # `|| status="000"` keeps a transient network failure (curl exits non-zero)
    # from aborting the whole run under `set -e`: it becomes a per-doc WARN below
    # and the loop moves on to the next project.
    status=$(curl -s -o "$RESP" -w "%{http_code}" \
      -X POST "$BASEMOUSE_BASE_URL/api/documents" \
      -H "Authorization: Bearer $BASEMOUSE_API_KEY" \
      -H "Content-Type: application/json" \
      -d "$payload") || status="000"

    if [ "$status" = "201" ] || [ "$status" = "200" ]; then
      echo "  created  $doc_id"
    elif [ "$status" = "409" ]; then
      # Already exists. Read the latest revision from the append-only history to
      # (a) get the current version for the optimistic-lock PUT and (b) compare
      # content. If body/title/tags are unchanged, skip the write entirely so a
      # re-run doesn't bump the version or grow history for an untouched doc.
      # Body/title are compared trimmed, matching the server's normalization.
      cur=$(curl -s "$BASEMOUSE_BASE_URL/api/documents/$doc_id/history" \
        -H "Authorization: Bearer $BASEMOUSE_API_KEY" \
        | jq -c '((.history // []) | max_by(.version)) // empty
                 | {version, body: .snapshot.body, title: .snapshot.title, tags: .snapshot.tags}') || cur=""
      ver=$(printf '%s' "$cur" | jq -r '.version // empty')
      if [ -z "$ver" ]; then
        echo "  WARN: $doc_id exists but its current revision could not be read -- skipped"
        continue
      fi
      # Compare trimmed, matching the server's JS String.prototype.trim(). `ws`
      # is that exact whitespace set as Oniguruma \x{HHHH} escapes (pure-ASCII
      # source): tab/LF/VT/FF/CR, space, NBSP, the Unicode Zs run, line/para
      # separators, and the BOM (U+FEFF) -- which jq's `\s` does NOT cover, so a
      # BOM/NBSP-edged file would otherwise never match and bump every run.
      unchanged=$(printf '%s' "$cur" | jq --arg title "$title" --arg body "$body" --arg tag "project:$slug" '
        def ws: "\\x{0009}-\\x{000d}\\x{0020}\\x{00a0}\\x{1680}\\x{2000}-\\x{200a}\\x{2028}\\x{2029}\\x{202f}\\x{205f}\\x{3000}\\x{feff}";
        def trim: sub("^[" + ws + "]+"; "") | sub("[" + ws + "]+$"; "");
        ((.body // "") | trim) == ($body | trim)
        and ((.title // "") | trim) == ($title | trim)
        and ((.tags // []) == [$tag])')
      if [ "$unchanged" = "true" ]; then
        echo "  unchanged $doc_id (v$ver)"
        continue
      fi
      put_payload=$(jq -n \
        --arg id "$doc_id" \
        --arg title "$title" \
        --arg body "$body" \
        --arg tag "project:$slug" \
        --argjson v "$ver" \
        '{id: $id, title: $title, body: $body, type: "note", tags: [$tag], expectedVersion: $v}')
      status=$(curl -s -o "$RESP" -w "%{http_code}" \
        -X PUT "$BASEMOUSE_BASE_URL/api/documents/$doc_id" \
        -H "Authorization: Bearer $BASEMOUSE_API_KEY" \
        -H "Content-Type: application/json" \
        -d "$put_payload") || status="000"
      if [ "$status" = "200" ]; then
        echo "  updated  $doc_id (v$ver -> v$((ver + 1)))"
      else
        echo "  WARN: update $doc_id returned HTTP $status — $(cat "$RESP")"
      fi
    else
      echo "  WARN: create $doc_id returned HTTP $status — $(cat "$RESP")"
    fi
  done
done

echo
echo "== Step 2: connect Claude Code to BaseMouse over MCP (native, works today) =="
cat <<EOF

BaseMouse speaks the Model Context Protocol at POST $BASEMOUSE_BASE_URL/mcp
(stateless JSON-RPC over Streamable HTTP), exposing the 'search' and
'get_context_pack' tools with the same auth, scoping, and quota as REST.

Note: registering writes the bm_ key into ~/.claude.json in plaintext (that's
how Claude Code stores MCP auth headers) -- keep that file chmod 600 and treat
it as a credential store.
EOF

# Register automatically when the claude CLI is present. Uses --scope user so
# the server is available in EVERY project on this machine, not just the cwd
# (claude mcp add defaults to local/project scope, which would contradict the
# "any session, any project" intent). Idempotent: a re-run skips if 'basemouse'
# is already registered (claude mcp add errors on a dup), so this stays safe to
# run every time docs change. Falls back to printing the command when the CLI is
# absent (e.g. running on a server or in CI).
if command -v claude >/dev/null 2>&1; then
  if claude mcp list 2>/dev/null | grep -q '^basemouse:'; then
    echo "  basemouse MCP already registered — leaving it as is"
    echo "  (to re-point or refresh the key: claude mcp remove basemouse, then re-run this script)"
  elif claude mcp add --scope user --transport http basemouse "$BASEMOUSE_BASE_URL/mcp" \
        --header "Authorization: Bearer $BASEMOUSE_API_KEY"; then
    echo "  registered basemouse MCP server (user scope) — verify with: claude mcp list"
  else
    echo "  WARN: 'claude mcp add' failed — register manually:"
    echo "    claude mcp add --scope user --transport http basemouse $BASEMOUSE_BASE_URL/mcp --header \"Authorization: Bearer \$BASEMOUSE_API_KEY\""
  fi
else
  echo "  'claude' CLI not found — skipping registration. On a machine with Claude"
  echo "  Code installed, run (with BASEMOUSE_API_KEY set in your environment):"
  echo "    claude mcp add --scope user --transport http basemouse $BASEMOUSE_BASE_URL/mcp --header \"Authorization: Bearer \$BASEMOUSE_API_KEY\""
fi

echo
echo "== Step 3: add this to each project's CLAUDE.md (do once per project) =="
cat <<'EOF'
## Context retrieval
This project's history and decisions are also stored in BaseMouse, tagged
`project:<slug>`. BaseMouse is registered as an MCP server (tools: `search`,
`get_context_pack`) -- call `get_context_pack` filtered to tag `project:<slug>`
to pull a cited, checksummed context pack scoped to this project. Over REST
that is:
  GET <base-url>/api/context-pack?tag=project:<slug>&limit=N
  (Authorization: Bearer <key> -- ask the user if you need it, don't guess)
EOF

echo
echo "Done. Re-run this script any time CLAUDE.md/PROGRESS.md changes -- creates"
echo "are idempotent, updates bump the version, and every revision is preserved"
echo "in BaseMouse's append-only history."
