// Import CLI tests: frontmatter derivation, slug rules, and the full
// folder-import flow against a live server — including the per-file failure
// policy (a bad file never aborts the run) and the env-var-only key rule.

import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.js';
import { MemoryStore } from '../src/memory-store.js';
import { hashKey, generateKey } from '../src/auth.js';
import { parseFrontmatter, slugify } from '../scripts/import.mjs';

const execFileAsync = promisify(execFile);
const IMPORT_SCRIPT = fileURLToPath(new URL('../scripts/import.mjs', import.meta.url));
const KEY = generateKey();

let server;
let base;
let dir;

before(async () => {
  const store = new MemoryStore([]);
  await store.createKey({ id: 'ws-import', plan: 'demo', keyHash: hashKey(KEY) });
  server = createApp(store, { seedCount: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  dir = await mkdtemp(join(tmpdir(), 'bm-import-'));
  await writeFile(join(dir, 'devops-runbook.md'), [
    '---',
    'title: DevOps Runbook',
    'type: policy',
    'tags: [ops, oncall]',
    '---',
    'When the pager goes off, breathe first.'
  ].join('\n'));
  await writeFile(join(dir, 'Plain Notes File.md'), 'Just a body, no frontmatter.');
  await writeFile(join(dir, 'empty.md'), '---\ntitle: Empty\n---\n');
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

test('parseFrontmatter extracts metadata and strips the block from the body', () => {
  const { meta, body } = parseFrontmatter('---\ntitle: Hello\ntags: a, b\n---\nThe body.');
  assert.equal(meta.title, 'Hello');
  assert.equal(body, 'The body.');

  const plain = parseFrontmatter('No frontmatter here.');
  assert.deepEqual(plain.meta, {});
  assert.equal(plain.body, 'No frontmatter here.');
});

test('slugify produces valid document ids from filenames', () => {
  assert.equal(slugify('Plain Notes File'), 'plain-notes-file');
  assert.equal(slugify('--Weird__Name--'), 'weird-name');
  assert.match(slugify('---'), /^doc-/);
});

test('import run: imports good files, skips empty ones, reports per-file results', async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [IMPORT_SCRIPT, dir, '--base-url', base],
    { env: { ...process.env, BASEMOUSE_API_KEY: KEY } }
  );

  assert.match(stdout, /imported\s+devops-runbook\.md/);
  assert.match(stdout, /imported\s+Plain Notes File\.md/);
  assert.match(stdout, /skipped\s+empty\.md/);
  assert.match(stdout, /2 imported, 1 skipped, 0 failed/);

  // Imported docs are immediately searchable through the key's workspace.
  const res = await fetch(`${base}/api/search?q=pager`, {
    headers: { Authorization: `Bearer ${KEY}` }
  });
  const body = await res.json();
  assert.ok(body.results.some((r) => r.id === 'devops-runbook'));
});

test('re-running the import skips existing ids instead of failing the run', async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [IMPORT_SCRIPT, dir, '--base-url', base],
    { env: { ...process.env, BASEMOUSE_API_KEY: KEY } }
  );
  assert.match(stdout, /0 imported, 3 skipped, 0 failed/);
});

test('refuses to run without BASEMOUSE_API_KEY (keys never travel via argv)', async () => {
  const env = { ...process.env };
  delete env.BASEMOUSE_API_KEY;
  await assert.rejects(
    execFileAsync(process.execPath, [IMPORT_SCRIPT, dir, '--base-url', base], { env }),
    /BASEMOUSE_API_KEY/
  );
});
