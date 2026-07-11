#!/usr/bin/env node
// Export a workspace's API-sourced documents as a retrieval-eval corpus.
//
// Real-corpus eval suites (TODOS P2) run the golden-query harness against a
// workspace's ACTUAL documents — which are private, so the corpus is exported
// at run time to a gitignored path instead of ever being committed.
//
//   BASEMOUSE_API_KEY=bm_... node scripts/export-corpus.mjs data/retrieval-eval/local/workspace-corpus.json
//
// Output shape is { items: [...] }, which evaluate-retrieval.mjs accepts
// directly (seed/demo docs are excluded — the suite targets the real corpus).

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const BASE_URL = (process.env.BASEMOUSE_BASE_URL || 'https://basemouse.com').replace(/\/$/, '');
const API_KEY = process.env.BASEMOUSE_API_KEY;
const outPath = process.argv[2];

if (!API_KEY) {
  console.error('BASEMOUSE_API_KEY env var is required (never pass keys as arguments).');
  process.exit(1);
}
if (!outPath) {
  console.error('usage: BASEMOUSE_API_KEY=bm_... node scripts/export-corpus.mjs <out.json>');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(offset, attempt = 0) {
  const res = await fetch(`${BASE_URL}/api/repository?limit=${PAGE}&offset=${offset}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (res.status === 429 && attempt < 2) {
    // The route is read-rate-limited; a multi-page export can trip it.
    await res.text().catch(() => {});
    const after = Number(res.headers.get('retry-after'));
    await sleep(Math.min((Number.isFinite(after) && after > 0 ? after : 2) * 1000, 30_000));
    return fetchPage(offset, attempt + 1);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    console.error(`repository listing failed: HTTP ${res.status} — ${text.slice(0, 200) || '(empty body)'}`);
    console.error('(check BASEMOUSE_API_KEY and BASEMOUSE_BASE_URL)');
    process.exit(1);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    console.error(`repository listing returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
    process.exit(1);
  }
  if (!Array.isArray(body?.items)) {
    console.error(`repository listing response has no items array: ${text.slice(0, 200)}`);
    process.exit(1);
  }
  return body;
}

const items = [];
const PAGE = 500; // server clamps limit to 500; the stride below adapts if that changes
const TIMEOUT_MS = 15_000;
// Adaptive stride: advance by however many items the server ACTUALLY returned
// and stop on an empty page — correct under any server-side page cap, and
// never silently truncates (a fixed +=PAGE stride would skip ranges if the
// cap dropped, and a count-based break would truncate if count went missing).
for (let offset = 0; ; ) {
  const body = await fetchPage(offset);
  if (body.items.length === 0) break;
  for (const item of body.items) {
    if (item?.source?.kind === 'api') items.push(item);
  }
  offset += body.items.length;
}
if (items.length === 0) {
  console.error('exported 0 workspace documents — is this key scoped to the right workspace?');
  process.exit(1);
}

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify({ items }, null, 2));
console.log(`exported ${items.length} workspace documents to ${outPath} (gitignored — private content)`);
