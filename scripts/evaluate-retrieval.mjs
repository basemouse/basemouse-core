#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { evaluateRetrievalSuite, formatRetrievalEvalReport } from '../src/retrieval-eval.js';
import { loadDocumentsSync } from '../src/store.js';

function usage() {
  return `Usage: node scripts/evaluate-retrieval.mjs --cases <cases.json> [options]

Options:
  --cases <path>        Golden query suite: array or { cases: [...] } (required)
  --corpus <path>       Corpus JSON: array or { documents/items: [...] } (default: data/seed)
  --retrieval <mode>    lexical | hybrid (default: hybrid)
  --min-recall <num>    Per-case minimum recall required for search and context-pack (default: 1)
  --json                Print JSON instead of a human report
  --help                Show this help
`;
}

function parseArgs(argv) {
  const out = { retrieval: 'hybrid', minRecall: 1, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--cases') out.cases = argv[++i];
    else if (arg === '--corpus') out.corpus = argv[++i];
    else if (arg === '--retrieval') out.retrieval = argv[++i];
    else if (arg === '--min-recall') out.minRecall = Number(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function readCases(path) {
  const parsed = readJson(path);
  return Array.isArray(parsed) ? parsed : parsed.cases;
}

function readCorpus(path) {
  if (!path) return loadDocumentsSync();
  const parsed = readJson(path);
  if (Array.isArray(parsed)) return parsed;
  return parsed.documents || parsed.items;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }
  if (!args.cases) throw new Error('--cases is required');
  if (!Number.isFinite(args.minRecall) || args.minRecall < 0 || args.minRecall > 1) {
    throw new Error('--min-recall must be a number between 0 and 1');
  }

  const suite = evaluateRetrievalSuite({
    items: readCorpus(args.corpus),
    cases: readCases(args.cases),
    retrieval: args.retrieval,
    minRecall: args.minRecall
  });

  if (args.json) console.log(JSON.stringify(suite, null, 2));
  else console.log(formatRetrievalEvalReport(suite));

  process.exit(suite.pass ? 0 : 1);
} catch (error) {
  console.error(error.message);
  console.error(usage());
  process.exit(2);
}
