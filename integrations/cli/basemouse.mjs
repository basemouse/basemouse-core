#!/usr/bin/env node
// basemouse.mjs — cross-platform sync CLI for BaseMouse.
//
// One tool, any platform (Windows/macOS/Linux — Node only, no bash/curl/jq),
// any coding agent (the MCP endpoint is tool-agnostic; `register` emits config
// for each client). Supersedes integrations/claude-code/basemouse-integration.sh.
//
//   basemouse sync                     push every project under ~/projects
//   basemouse sync --only meshai       push one project (name or slug)
//   basemouse sync --single [dir]      push one directory (defaults to cwd) —
//                                      the mode the GitHub Action uses
//   basemouse watch                    reconcile once, then auto-push on save
//   basemouse register [tool]          MCP config for claude|cursor|windsurf|
//                                      codex|gemini (no arg: print all)
//   basemouse snippet [slug]           the CLAUDE.md "Context retrieval" block
//
// Env: BASEMOUSE_API_KEY (required for sync/watch; sync/watch never place it
//      in any argv — `register claude` must hand it to the claude CLI on its
//      command line, and says so before doing it),
//      BASEMOUSE_BASE_URL (default https://basemouse.com),
//      BASE_DIR (default ~/projects).
//
// Sync semantics (design doc D9): each tracked file is ONE idempotent
// `PUT /api/documents/:id?mode=upsert` — the SERVER decides created /
// unchanged / updated next to its own normalization, merges tags additively,
// and an unchanged write never grows the append-only history. No client-side
// comparison exists here anymore (the old create→409→history→compare→PUT
// choreography byte-replicated server trim semantics and drifted twice).
// Requires a server with upsert support (basemouse.com, or self-hosted ≥ the
// D9 release); older servers get a clear upgrade message, not silent misuse.
// Per-doc failures WARN and continue; they never abort the run.

import { readFile, readdir, stat } from 'node:fs/promises';
import { watch } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';

const BASE_URL = (process.env.BASEMOUSE_BASE_URL || 'https://basemouse.com').replace(/\/$/, '');
const API_KEY = process.env.BASEMOUSE_API_KEY || '';
const TRACKED_FILES = ['CLAUDE.md', 'PROGRESS.md'];
const TIMEOUT_MS = 15_000;
// Server MAX_DOC_BODY_BYTES (256 KB) caps the whole JSON envelope; keep 1 KB
// of headroom for envelope fields and escaping variance.
const MAX_PAYLOAD_BYTES = 256 * 1024 - 1024;

const log = (msg) => console.log(msg);
const warn = (msg) => console.warn(`  WARN: ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- pure helpers (exported for tests) ---------------------------------------

export function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Pre-flight the payload against server validation so predictable rejections
// don't turn into cryptic HTTP errors (or a permanently red CI job).
// Returns null when fine, otherwise 'empty' | 'too-large'.
export function payloadIssue(doc) {
  if (!doc.body || doc.body.trim().length === 0) return 'empty';
  if (Buffer.byteLength(JSON.stringify(doc), 'utf8') > MAX_PAYLOAD_BYTES) return 'too-large';
  return null;
}

// --- HTTP --------------------------------------------------------------------

// Bounded retries: thrown network/timeout errors back off and retry (they are
// transient in this infra — see scripts/smoke.mjs), 429 honors the server's
// Retry-After, and 409 concurrent_write (the upsert's retryable conflict
// signal) waits briefly and retries. Other HTTP statuses return as-is. The
// raw body text is kept when it isn't JSON so diagnostics never degrade to
// "— null".
async function api(method, path, body, { retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch (error) {
      if (attempt >= retries) throw error;
      await sleep(750 * (attempt + 1));
      continue;
    }
    if (res.status === 429 && attempt < retries) {
      const after = Number(res.headers.get('retry-after'));
      await sleep(Math.min((Number.isFinite(after) && after > 0 ? after : 2) * 1000, 30_000));
      continue;
    }
    let json = null;
    let text = '';
    try {
      text = await res.text();
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null; // non-JSON body (proxy error page); keep `text` for diagnostics
    }
    if (res.status === 409 && json?.error === 'concurrent_write' && attempt < retries) {
      await sleep(500 * (attempt + 1)); // server exhausted ITS retries; brief backoff, try again
      continue;
    }
    return { status: res.status, json, text };
  }
}

const detail = (res) => (res.json ? JSON.stringify(res.json) : (res.text || '').slice(0, 200) || '(empty body)');

function requireKey() {
  if (!API_KEY) {
    console.error('BASEMOUSE_API_KEY env var is required (never pass keys as arguments).');
    process.exit(1);
  }
}

// --- sync --------------------------------------------------------------------

async function syncDoc(slug, fileName, filePath, counts) {
  const docId = `${slug}-${fileName.toLowerCase().replace(/\./g, '-')}`;
  const tag = `project:${slug}`;
  const title = `${slug} — ${fileName}`;
  let body;
  try {
    body = await readFile(filePath, 'utf8');
  } catch (error) {
    warn(`${docId}: unreadable (${error.message}) — skipped`);
    counts.failed += 1;
    return;
  }
  const doc = { id: docId, title, body, type: 'note', tags: [tag] };

  const issue = payloadIssue(doc);
  if (issue === 'empty') {
    // A stub file is not an error: the server would 400 ("body is required"),
    // and failing here would keep a CI job red until someone writes content.
    log(`  skipped   ${docId} (empty file — server requires a non-empty body)`);
    counts.skipped += 1;
    return;
  }
  if (issue === 'too-large') {
    warn(`${docId}: JSON payload exceeds the server's 256KB document cap — trim or split the file; skipped`);
    counts.failed += 1;
    return;
  }

  try {
    // One idempotent call — the server owns the compare (D9). Tags merge
    // additively server-side, so user-added tags are never destroyed.
    const res = await api('PUT', `/api/documents/${docId}?mode=upsert`, doc);
    if ((res.status === 200 || res.status === 201) && res.json?.outcome) {
      const { outcome, document } = res.json;
      const pad = { created: 'created  ', unchanged: 'unchanged', updated: 'updated  ' }[outcome] ?? outcome;
      log(`  ${pad} ${docId} (v${document.version})`);
      counts[outcome] += 1;
      return;
    }
    if (res.status === 400 && /expectedVersion/.test(res.json?.message ?? '')) {
      // A pre-D9 server routed ?mode=upsert to the plain optimistic-lock PUT.
      warn(`${docId}: this server predates upsert support — upgrade basemouse-core (or pin an older CLI); skipped`);
      counts.failed += 1;
      return;
    }
    warn(`upsert ${docId} returned HTTP ${res.status} — ${detail(res)}`);
    counts.failed += 1;
  } catch (error) {
    // Transient network/timeout after retries: per-doc WARN, never abort the run.
    warn(`${docId}: ${error.message} — skipped`);
    counts.failed += 1;
  }
}

async function syncProject(dir, counts, slugOverride) {
  const slug = slugOverride || slugify(basename(resolve(dir)));
  if (!slug) {
    // Loud, not silent: a fully non-alphanumeric name has no valid doc id.
    warn(`"${basename(resolve(dir))}" produces an empty slug — pass --slug (or rename); skipped`);
    counts.failed += 1;
    return;
  }
  for (const fileName of TRACKED_FILES) {
    const filePath = join(dir, fileName);
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) continue;
    await syncDoc(slug, fileName, filePath, counts);
  }
}

// Shared by cmdSync (workspace mode) and cmdWatch's startup reconciliation.
// `only` matches either the raw directory name or its slug — users only ever
// see the slug in doc ids/tags/output, so both must work.
async function syncWorkspace(baseDir, counts, { only } = {}) {
  const entries = await readdir(baseDir, { withFileTypes: true });
  let matched = false;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (only && entry.name !== only && slugify(entry.name) !== slugify(only)) continue;
    matched = true;
    await syncProject(join(baseDir, entry.name), counts);
  }
  if (only && !matched) {
    console.error(`no project directory matching "--only ${only}" under ${baseDir}`);
    process.exitCode = 1;
  }
}

function summarize(counts) {
  const total = counts.created + counts.updated + counts.unchanged + counts.skipped + counts.failed;
  log(`\n${counts.created} created, ${counts.updated} updated, ${counts.unchanged} unchanged, ${counts.skipped} skipped, ${counts.failed} failed (${total} docs)`);
  if (counts.failed > 0) process.exitCode = 1;
}

const newCounts = () => ({ created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 });

async function cmdSync(values, positionals) {
  requireKey();
  const counts = newCounts();

  if (values.single) {
    const dir = resolve(positionals[0] || '.');
    log(`== syncing project ${dir} ==`);
    await syncProject(dir, counts, values.slug ? slugify(values.slug) : undefined);
  } else {
    const baseDir = resolve(values['base-dir'] || process.env.BASE_DIR || join(homedir(), 'projects'));
    log(`== syncing workspace ${baseDir} ==`);
    await syncWorkspace(baseDir, counts, { only: values.only });
  }

  summarize(counts);
  if (!values.single) {
    log('next steps: `basemouse register` prints MCP config for your coding tools;');
    log('`basemouse snippet <slug>` prints the CLAUDE.md context-retrieval block.');
  }
}

// --- watch ---------------------------------------------------------------------

async function cmdWatch(values) {
  requireKey();
  const baseDir = resolve(values['base-dir'] || process.env.BASE_DIR || join(homedir(), 'projects'));
  const debounceMs = Number(values.debounce ?? 2000);
  if (!Number.isFinite(debounceMs) || debounceMs < 0) {
    console.error(`invalid --debounce "${values.debounce}" — expected a non-negative number of milliseconds`);
    process.exit(1);
  }

  // Reconcile first: edits made while the watcher was down would otherwise
  // never sync until the file happens to be saved again.
  log(`[watch] initial sync of ${baseDir}…`);
  const initial = newCounts();
  await syncWorkspace(baseDir, initial);
  log(`[watch] initial sync: ${initial.created} created, ${initial.updated} updated, ${initial.unchanged} unchanged, ${initial.skipped} skipped, ${initial.failed} failed`);

  const pending = new Map(); // project name -> timer
  const queue = new Set();
  let running = false;

  const runOne = async (name) => {
    if (running) { queue.add(name); return; }
    running = true;
    log(`[watch] syncing ${name}…`);
    const counts = newCounts();
    try {
      await syncProject(join(baseDir, name), counts);
    } catch (error) {
      warn(`[watch] ${name}: ${error.message}`);
    }
    running = false;
    const next = queue.values().next().value;
    if (next !== undefined) { queue.delete(next); void runOne(next); }
  };

  log(`[watch] watching ${baseDir} for ${TRACKED_FILES.join('/')} changes (debounce ${debounceMs}ms)`);
  watch(baseDir, { recursive: true }, (_event, filename) => {
    if (!filename || !TRACKED_FILES.includes(basename(filename))) return;
    const project = filename.split(/[\\/]/)[0];
    if (!project || project === filename) return; // file at baseDir root, not in a project
    clearTimeout(pending.get(project));
    pending.set(project, setTimeout(() => {
      pending.delete(project);
      void runOne(project);
    }, debounceMs));
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { log(`[watch] ${sig} — stopping.`); process.exit(0); });
  }
}

// --- register ------------------------------------------------------------------

// Config snippets per tool. Formats move fast across these clients, so each
// snippet names the file it belongs in and defers to the tool's docs as the
// source of truth. The key placeholder stays a placeholder in printed output —
// only the `register claude` exec path handles the real key, and it says so.
function registerSnippets() {
  const url = `${BASE_URL}/mcp`;
  const auth = 'Bearer $BASEMOUSE_API_KEY';
  return {
    claude: {
      file: 'run this command',
      snippet: `claude mcp add --scope user --transport http basemouse ${url} \\\n  --header "Authorization: ${auth}"`
    },
    cursor: {
      file: '~/.cursor/mcp.json',
      snippet: JSON.stringify({ mcpServers: { basemouse: { url, headers: { Authorization: auth } } } }, null, 2)
    },
    windsurf: {
      file: '~/.codeium/windsurf/mcp_config.json',
      snippet: JSON.stringify({ mcpServers: { basemouse: { serverUrl: url, headers: { Authorization: auth } } } }, null, 2)
    },
    codex: {
      // Verified against Codex CLI: --bearer-token-env-var reads the key from
      // the environment at use time, so no secret is ever stored in config.toml.
      file: 'run this command',
      snippet: `codex mcp add basemouse --url ${url} --bearer-token-env-var BASEMOUSE_API_KEY`
    },
    gemini: {
      // Verified against Gemini CLI (requires the server to answer MCP ping).
      file: 'run this command',
      snippet: `gemini mcp add -s user -t http basemouse ${url} \\\n  -H "Authorization: ${auth}"`
    }
  };
}

const KEY_AT_REST_WARNING =
  'note: claude stores the Authorization header in PLAINTEXT in ~/.claude.json —\n' +
  'keep that file chmod 600 and treat it as a credential store.';

function cmdRegister(positionals) {
  const tools = registerSnippets();
  const target = positionals[0];
  // Validate before doing anything with the lookup — and use Object.hasOwn so
  // prototype names ("constructor") don't slip past as known tools.
  if (target && target !== 'claude' && !Object.hasOwn(tools, target)) {
    console.error(`unknown tool "${target}" — one of: ${Object.keys(tools).join(', ')}`);
    process.exit(1);
  }

  if (target === 'claude') {
    requireKey();
    if (process.platform === 'win32') {
      // spawnSync can't resolve npm's claude.cmd shim without shell:true (and
      // shell quoting of the header is its own hazard) — print, don't exec.
      log('On Windows, run the command yourself (with BASEMOUSE_API_KEY set in your environment):');
      log(tools.claude.snippet);
      log(KEY_AT_REST_WARNING);
      return;
    }
    const probe = spawnSync('claude', ['mcp', 'list'], { encoding: 'utf8' });
    if (probe.error) {
      console.error("'claude' CLI not found — run the printed command on a machine that has it:");
      log(tools.claude.snippet);
      process.exit(1);
    }
    if (/^basemouse:/m.test(probe.stdout || '')) {
      log('basemouse MCP already registered — leaving it as is.');
      return;
    }
    // The claude CLI only accepts headers as arguments, so the key is briefly
    // visible in local process listings while `claude mcp add` runs. Say so —
    // users on shared machines can paste the snippet themselves instead.
    log('registering (the key passes to `claude` on its command line — briefly');
    log('visible in local process listings; on shared machines, paste the');
    log('printed snippet yourself instead of using `register claude`):');
    const add = spawnSync('claude', [
      'mcp', 'add', '--scope', 'user', '--transport', 'http', 'basemouse',
      `${BASE_URL}/mcp`, '--header', `Authorization: Bearer ${API_KEY}`
    ], { stdio: 'inherit' });
    if ((add.status ?? 1) === 0) {
      log(KEY_AT_REST_WARNING);
    } else {
      console.error('`claude mcp add` failed — register manually:');
      log(tools.claude.snippet);
      process.exitCode = add.status ?? 1;
    }
    return;
  }

  const selected = target ? { [target]: tools[target] } : tools;
  log(`BaseMouse MCP endpoint: ${BASE_URL}/mcp (tools: search, get_context_pack, upsert_document)`);
  log('Substitute $BASEMOUSE_API_KEY yourself; formats below are indicative — the');
  log("tool's own MCP docs are the source of truth if its config schema has moved.\n");
  for (const [name, { file, snippet }] of Object.entries(selected)) {
    log(`--- ${name} (${file}) ---`);
    log(snippet);
    log('');
  }
}

// --- snippet ---------------------------------------------------------------------

// The per-project CLAUDE.md block the deprecated bash script printed as its
// Step 3 — dropped in the first CLI cut, restored as its own command.
function cmdSnippet(positionals) {
  const slug = slugify(positionals[0] || basename(resolve('.')));
  if (!slug) {
    console.error('cannot derive a slug — pass one: basemouse snippet <slug>');
    process.exit(1);
  }
  log(`## Context retrieval
This project's history and decisions are also stored in BaseMouse, tagged
\`project:${slug}\`. BaseMouse is registered as an MCP server (tools: \`search\`,
\`get_context_pack\`, \`upsert_document\`) -- call \`get_context_pack\` filtered to
tag \`project:${slug}\` to pull a cited, checksummed context pack scoped to this
project, and \`upsert_document\` to persist decisions by stable id. Over REST:
  GET ${BASE_URL}/api/context-pack?tag=project:${slug}&limit=N
  (Authorization: Bearer <key> -- ask the user if you need it, don't guess)`);
}

// --- entrypoint ------------------------------------------------------------------

const HELP = `basemouse — cross-platform BaseMouse sync CLI

usage:
  node basemouse.mjs sync [--base-dir DIR] [--only NAME]     sync a workspace of projects
  node basemouse.mjs sync --single [DIR] [--slug NAME]       sync one project directory
  node basemouse.mjs watch [--base-dir DIR] [--debounce MS]  reconcile, then auto-sync on save
  node basemouse.mjs register [claude|cursor|windsurf|codex|gemini]
  node basemouse.mjs snippet [slug]                          CLAUDE.md context-retrieval block

env: BASEMOUSE_API_KEY (required for sync/watch), BASEMOUSE_BASE_URL, BASE_DIR`;

const isMain = process.argv[1] && basename(process.argv[1]) === 'basemouse.mjs';
if (isMain) {
  // Hard floor before anything runs: fetch needs Node >= 18 and recursive
  // fs.watch on Linux needs >= 20; a clear message beats a bare
  // ERR_FEATURE_UNAVAILABLE_ON_PLATFORM stack (engines in package.json is
  // never enforced for a directly-run script).
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) {
    console.error(`basemouse CLI requires Node 20+ (found ${process.versions.node})`);
    process.exit(1);
  }

  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'base-dir': { type: 'string' },
      only: { type: 'string' },
      single: { type: 'boolean', default: false },
      slug: { type: 'string' },
      debounce: { type: 'string' },
      help: { type: 'boolean', default: false }
    }
  });

  const [command, ...rest] = positionals;
  if (values.help || !command) { log(HELP); process.exit(values.help ? 0 : 1); }
  if (command === 'sync') await cmdSync(values, rest);
  else if (command === 'watch') await cmdWatch(values);
  else if (command === 'register') cmdRegister(rest);
  else if (command === 'snippet') cmdSnippet(rest);
  else { console.error(`unknown command "${command}"\n`); log(HELP); process.exit(1); }
}
