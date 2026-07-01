import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDocuments, loadDocumentsSync, normalizeDocument } from '../src/store.js';

test('seed repository loads with provenance and is sorted by recency', async () => {
  const docs = await loadDocuments();
  assert.ok(docs.length >= 6);
  for (const doc of docs) {
    assert.match(doc.checksum, /^[0-9a-f]{16}$/);
    assert.equal(doc.source.kind, 'seed');
    assert.match(doc.source.path, /^data\/seed\/.+\.json$/);
    assert.ok(doc.body.length > 0);
  }
  // Descending updatedAt ordering.
  for (let i = 1; i < docs.length; i += 1) {
    assert.ok(String(docs[i - 1].updatedAt) >= String(docs[i].updatedAt));
  }
});

test('loadDocumentsSync matches the async loader', async () => {
  const sync = loadDocumentsSync();
  const async = await loadDocuments();
  assert.deepEqual(sync, async);
});

test('checksum is stable across loads but changes with content', () => {
  const a = normalizeDocument({ id: 'x', title: 'T', body: 'B', type: 'note' });
  const b = normalizeDocument({ id: 'x', title: 'T', body: 'B', type: 'note' });
  const c = normalizeDocument({ id: 'x', title: 'T', body: 'different', type: 'note' });
  assert.equal(a.checksum, b.checksum);
  assert.notEqual(a.checksum, c.checksum);
});

test('normalizeDocument rejects invalid documents', () => {
  assert.throws(() => normalizeDocument({ title: 'no id', body: 'b' }), /id must be/);
  assert.throws(() => normalizeDocument({ id: 'Bad_ID', title: 't', body: 'b' }), /id must be/);
  assert.throws(() => normalizeDocument({ id: 'ok', body: 'b' }), /title is required/);
  assert.throws(() => normalizeDocument({ id: 'ok', title: 't' }), /body is required/);
  assert.throws(() => normalizeDocument({ id: 'ok', title: 't', body: 'b', type: 'bogus' }), /type/);
  assert.throws(() => normalizeDocument({ id: 'ok', title: 't', body: 'b', tags: 'x' }), /tags/);
  assert.throws(() => normalizeDocument({ id: 'ok', title: 't', body: 'b', version: 0 }), /version/);
  assert.throws(() => normalizeDocument({ id: 'ok', title: 't', body: 'b', updatedAt: 'yesterday' }), /ISO/);
});

test('loadDocuments rejects duplicate ids', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'basemouse-seed-'));
  try {
    const doc = JSON.stringify({ id: 'dupe', title: 'A', body: 'B' });
    await writeFile(join(dir, 'a.json'), doc);
    await writeFile(join(dir, 'b.json'), doc);
    await assert.rejects(() => loadDocuments(dir), /duplicate id/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadDocuments reports malformed JSON with file context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'basemouse-seed-'));
  try {
    await writeFile(join(dir, 'broken.json'), '{ not json');
    await assert.rejects(() => loadDocuments(dir), /broken\.json/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
