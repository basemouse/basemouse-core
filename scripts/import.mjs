#!/usr/bin/env node
// Import a folder of markdown files into BaseMouse via the write API — the
// day-one on-ramp for real corpora (design decision D3.4). Title/tags/type
// come from YAML frontmatter when present, with sensible fallbacks. The key
// is read ONLY from the BASEMOUSE_API_KEY env var (argv leaks via shell
// history and `ps` — design decision 3A).
//
//   BASEMOUSE_API_KEY=bm_... node scripts/import.mjs ./docs [--base-url https://basemouse.com]
//
// Per-file failure policy (error registry): a bad file never aborts the run;
// the summary reports imported/skipped/failed with reasons.

import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'base-url': { type: 'string', default: 'http://localhost:3000' },
    type: { type: 'string', default: 'note' }
  }
});

const folder = positionals[0];
const apiKey = process.env.BASEMOUSE_API_KEY;

// Minimal frontmatter parser: leading `---` block with `key: value` lines.
// Tags accept JSON arrays or comma-separated strings. Deliberately not a
// full YAML parser — explicit over clever, and zero new dependencies.
export function parseFrontmatter(raw) {
  const meta = {};
  let body = raw;
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (match) {
    body = raw.slice(match[0].length);
    for (const line of match[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (!key) continue;
      meta[key] = value;
    }
  }
  return { meta, body: body.trim() };
}

export function slugify(name) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return /^[a-z0-9]/.test(slug) ? slug : `doc-${slug}`;
}

function parseTags(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    /* fall through to comma-separated */
  }
  return value.replace(/^\[|\]$/g, '').split(',').map((t) => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

async function importFile(file, dir, baseUrl) {
  const raw = await readFile(join(dir, file), 'utf8');
  const { meta, body } = parseFrontmatter(raw);
  if (!body) return { file, status: 'skipped', reason: 'empty body' };

  const doc = {
    id: slugify(meta.id || basename(file, extname(file))),
    title: meta.title || basename(file, extname(file)),
    type: meta.type || values.type,
    tags: parseTags(meta.tags),
    body
  };

  const res = await fetch(`${baseUrl}/api/documents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(doc)
  });
  if (res.status === 201) return { file, status: 'imported', id: doc.id };
  if (res.status === 409) return { file, status: 'skipped', reason: `id "${doc.id}" already exists` };
  const payload = await res.json().catch(() => ({}));
  return { file, status: 'failed', reason: `${res.status} ${payload.error || ''} ${payload.message || ''}`.trim() };
}

// Only run the import when executed directly (the parser is imported by tests).
if (process.argv[1] && process.argv[1].endsWith('import.mjs')) {
  if (!folder) {
    console.error('usage: BASEMOUSE_API_KEY=bm_... node scripts/import.mjs <folder> [--base-url URL]');
    process.exit(1);
  }
  if (!apiKey) {
    console.error('BASEMOUSE_API_KEY env var is required (never pass keys as arguments)');
    process.exit(1);
  }
  const info = await stat(folder).catch(() => null);
  if (!info?.isDirectory()) {
    console.error(`not a directory: ${folder}`);
    process.exit(1);
  }

  const files = (await readdir(folder)).filter((f) => /\.(md|markdown)$/i.test(f)).sort();
  if (files.length === 0) {
    console.error(`no markdown files in ${folder}`);
    process.exit(1);
  }

  const results = [];
  for (const file of files) {
    try {
      results.push(await importFile(file, folder, values['base-url']));
    } catch (error) {
      results.push({ file, status: 'failed', reason: error.message });
    }
  }

  const counts = { imported: 0, skipped: 0, failed: 0 };
  for (const r of results) {
    counts[r.status] += 1;
    const detail = r.id ? `→ ${r.id}` : r.reason || '';
    console.log(`${r.status.padEnd(8)} ${r.file} ${detail}`);
  }
  console.log(`\n${counts.imported} imported, ${counts.skipped} skipped, ${counts.failed} failed (${files.length} files)`);
  if (counts.failed > 0) process.exitCode = 1;
}
