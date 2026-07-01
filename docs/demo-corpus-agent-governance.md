# Agent governance demo corpus

This synthetic corpus gives BaseMouse a representative retrieval-quality fixture
until a real design-partner corpus is available. It is deliberately aligned with
BaseMouse + MeshAI positioning: agent governance, EU AI Act-style evidence,
OpenTelemetry retrieval spans, cost intelligence, policy controls, and incident
response.

## Files

- `data/demo-corpus/agent-governance.json` — 35 synthetic but realistic docs.
- `data/retrieval-eval/agent-governance-demo.json` — 20 golden queries with
  human-readable expected document ids.
- `public/agent-governance-demo.html` — public demo page that packages the
  corpus, sample queries, context-pack shape, and retrieval baseline for sales
  and design-partner conversations.

## Public demo flow

Open the local or hosted page:

```text
http://localhost:3000/agent-governance-demo.html
https://basemouse.com/agent-governance-demo.html
```

The page intentionally shows the demo as an evidence loop:

1. corpus: 35 governance docs,
2. golden queries: 20 auditor/operator prompts,
3. context pack: cited, checksummed grounding metadata,
4. eval baseline: lexical and hybrid recall/MRR.

## Run baselines

```bash
npm run eval:retrieval:demo

node scripts/evaluate-retrieval.mjs \
  --corpus data/demo-corpus/agent-governance.json \
  --cases data/retrieval-eval/agent-governance-demo.json \
  --retrieval lexical

node scripts/evaluate-retrieval.mjs \
  --corpus data/demo-corpus/agent-governance.json \
  --cases data/retrieval-eval/agent-governance-demo.json \
  --retrieval hybrid
```

The demo suite is not a replacement for a design-partner corpus. Its job is to
exercise realistic query shapes and make the retrieval roadmap measurable before
semantic embeddings or full GraphRAG are added.

## How to use it

1. Keep this suite green as a demo regression check.
2. Record lexical and hybrid baselines before retrieval changes.
3. Add a partner-corpus suite when real docs arrive.
4. Only claim learned semantic embedding or GraphRAG improvements when they beat
   these baselines and, more importantly, a real-corpus baseline.
