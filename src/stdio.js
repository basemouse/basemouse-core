// MCP over stdio: the local door to the same product. Config-file MCP clients
// (Claude Desktop, Cursor, and directory build-probes that spawn a command and
// speak JSON-RPC over stdin/stdout) need a stdio transport; the HTTP server in
// server.js is the remote door. Both call the identical handleMcpRequest, so
// auth, scoping, validation, and the write contract are shared — there is no
// second implementation to drift out of sync.
//
// This entrypoint is deliberately keyless and memory-mode: it never reads
// DATABASE_URL or any bm_ credential, so it serves only the public demo corpus
// from an in-memory store. Anonymous scoping (visibleWorkspaces(null)) means
// reads see the demo corpus and upsert_document is refused by the handler —
// exactly the headerless HTTP contract. An operator who wants their own
// workspace runs the HTTP server with a key; the stdio door stays public-only.

import { createInterface } from 'node:readline';
import { loadDocuments } from './store.js';
import { MemoryStore } from './memory-store.js';
import { visibleWorkspaces } from './auth.js';
import { handleMcpRequest } from './handlers/mcp.js';

// Anonymous, memory-mode store: the demo corpus, no DB, no secrets.
const store = new MemoryStore(await loadDocuments());
const auth = null; // no Authorization on stdio → anonymous, same as headerless HTTP

// MCP stdio framing: one JSON message per line, and nothing that is not a
// valid MCP message may touch stdout (diagnostics belong on stderr).
function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;

  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    // Parse error: the id is unknowable, so null per JSON-RPC 2.0.
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    continue;
  }

  // Recompute the visible corpus per message to mirror the HTTP route's
  // per-request loadVisible; anonymous scope keeps this to the public demo.
  const docs = await store.listVisible(visibleWorkspaces(auth));
  const reply = await handleMcpRequest(message, {
    docs,
    auth,
    meterPackPull: null, // metering is for authenticated plans; anonymous never meters
    store,
    writeLimits: null // no write budget → upsert_document is refused, as anonymous HTTP
  });

  // handleMcpRequest returns null for notifications (e.g. `initialized`); the
  // HTTP door answers 202 with no body, so stdio simply writes nothing.
  if (reply !== null) write(reply);
}
