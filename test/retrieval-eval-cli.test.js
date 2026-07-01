import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;

test('scripts/evaluate-retrieval.mjs runs a golden query suite and emits JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'basemouse-retrieval-eval-'));
  const corpusPath = join(dir, 'corpus.json');
  const casesPath = join(dir, 'cases.json');

  writeFileSync(corpusPath, JSON.stringify([
    { id: 'alpha', title: 'Alpha Policy', type: 'policy', tags: ['alpha'], body: 'API keys must be rotated and never logged.' },
    { id: 'beta', title: 'Beta Runbook', type: 'note', tags: ['beta'], body: 'Stripe checkout creates a claim page for API keys.' }
  ]));
  writeFileSync(casesPath, JSON.stringify({
    cases: [
      { id: 'keys', query: 'rotated API keys logging', expected: ['alpha'], limit: 2 },
      { id: 'stripe', query: 'stripe claim page', expected: ['beta'], limit: 2 }
    ]
  }));

  const output = execFileSync('node', [
    'scripts/evaluate-retrieval.mjs',
    '--corpus', corpusPath,
    '--cases', casesPath,
    '--retrieval', 'hybrid',
    '--json'
  ], { cwd: root, encoding: 'utf8' });

  const parsed = JSON.parse(output);
  assert.equal(parsed.pass, true);
  assert.equal(parsed.summary.total, 2);
  assert.equal(parsed.summary.failed, 0);
});
