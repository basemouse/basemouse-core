# Retrieval quality evaluation

BaseMouse has a small, dependency-free retrieval evaluation harness so retrieval
changes can be judged against golden queries instead of vibes.

## Run the seed suite

```bash
npm run eval:retrieval
```

This runs `scripts/evaluate-retrieval.mjs` against
`data/retrieval-eval/golden-seed.json` using `retrieval=hybrid`.

## Run the Agent Governance Demo suite

```bash
npm run eval:retrieval:demo
```

This runs the public demo fixture:

- corpus: `data/demo-corpus/agent-governance.json`
- golden queries: `data/retrieval-eval/agent-governance-demo.json`
- page: `/agent-governance-demo.html`

Current baseline: 20/20 cases pass with 100% search/context-pack recall and
hybrid MRR 0.900. Treat it as a realistic demo/regression fixture, not a
substitute for a design-partner corpus.

Example output:

```text
PASS retrieval eval: 5/5 cases passed
mode=hybrid minRecall=100% searchRecall=100% contextPackRecall=100% ...
```

## What it scores

For each golden case the harness calls both:

- `searchRepository` / `hybridSearchWithVectors`
- `createContextPack`

It records:

- retrieved ids
- expected ids hit/missed
- recall
- precision
- MRR
- pass/fail for both search and context-pack results

A case passes only when **both** search and context-pack recall meet
`--min-recall` (default `1`, i.e. every expected document must appear within the
case limit).

The suite loader is deliberately strict: `id`, `query`, and `expected` are
required; `expected` ids must be unique; `limit` must be a positive integer when
present; and `minRecall` must be a number between `0` and `1`. Invalid retrieval
modes are rejected, while case-insensitive modes such as `HYBRID` are normalized
to `hybrid` in the report.

## Golden suite shape

```json
{
  "cases": [
    {
      "id": "agent-context-packs",
      "query": "structured versioned context packs for AI agents",
      "expected": ["agent-context-engine", "agent-prompt-templates"],
      "limit": 5
    }
  ]
}
```

The seed suite is intentionally a smoke test. The important next step is adding
one suite per real design-partner corpus.

For partner suites, prefer:

- ≥20 queries that reflect real agent/user wording, not only exact document
  titles.
- Expected ids reviewed by a human who knows the corpus.
- A `limit` that matches product behavior (usually 5–10), not a huge safety net.
- Separate suites per corpus so quality regressions can be tied to a data shape.

## CLI usage

```bash
node scripts/evaluate-retrieval.mjs \
  --cases data/retrieval-eval/golden-seed.json \
  --retrieval hybrid

node scripts/evaluate-retrieval.mjs \
  --corpus ./partner-corpus.json \
  --cases ./partner-golden.json \
  --retrieval lexical \
  --min-recall 0.8 \
  --json
```

`--corpus` may be either an array of documents or an object containing
`documents`/`items`. When omitted, the in-repo seed corpus from `data/seed` is
loaded through `src/store.js` so checksums/provenance match the app.

## CI guidance

Keep the seed suite in CI as a regression smoke test. Add partner-corpus suites
once they exist, but avoid overfitting retrieval changes to the 10 seed docs —
those are too small to prove semantic quality.

## Roadmap tie-in

Use this harness as the gate for retrieval roadmap work:

1. Add a real partner-corpus suite.
2. Record the lexical + local-hashed-vector baseline.
3. Add a learned embedding provider only if it improves measured recall/MRR.
4. Add full GraphRAG/multi-hop traversal only after the semantic baseline is
   measurable.
