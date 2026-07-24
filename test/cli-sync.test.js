// Unit tests for the pure logic of integrations/cli/basemouse.mjs (the sync
// CLI): slug derivation and payload pre-flight. Content comparison and tag
// merging are deliberately NOT here anymore — since the D9 migration the
// SERVER owns both (PUT ?mode=upsert), covered by test/documents-api.test.js
// and test/mcp.test.js. The module guards its entrypoint on argv[1], so
// importing it here executes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { slugify, payloadIssue } from '../integrations/cli/basemouse.mjs';

test('slugify lowercases and collapses non-alphanumerics', () => {
  assert.equal(slugify('MeshAI'), 'meshai');
  assert.equal(slugify('My App'), 'my-app');
  assert.equal(slugify('base_mouse--2'), 'base-mouse-2');
  assert.equal(slugify('--edge--'), 'edge');
});

test('slugify returns empty string for fully non-alphanumeric names (caller must warn)', () => {
  assert.equal(slugify('日本語'), '');
  assert.equal(slugify('---'), '');
});

test('payloadIssue flags empty and whitespace-only bodies', () => {
  assert.equal(payloadIssue({ id: 'x', title: 't', body: '', tags: [] }), 'empty');
  assert.equal(payloadIssue({ id: 'x', title: 't', body: ' \n\t ', tags: [] }), 'empty');
});

test('payloadIssue flags payloads exceeding the server 256KB envelope cap', () => {
  const big = { id: 'x', title: 't', type: 'note', tags: ['project:x'], body: 'a'.repeat(256 * 1024) };
  assert.equal(payloadIssue(big), 'too-large');
  const fine = { ...big, body: 'a'.repeat(64 * 1024) };
  assert.equal(payloadIssue(fine), null);
});
