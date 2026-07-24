# Contributing to BaseMouse

Thanks for your interest in BaseMouse — context infrastructure for AI agents.
The core is open source under the [MIT License](LICENSE), and contributions are
welcome.

## Ground rules

- **Be accurate, never overclaim.** Pricing copy, docs, and READMEs must describe
  what the code actually does today. If something is on the roadmap, label it as
  roadmap.
- **No secrets in the repo.** Never commit API keys, Stripe secret/restricted
  keys, price IDs, webhook secrets, or `.env` files. Secrets are loaded from the
  environment and stay server-side. The browser only ever receives the
  projection produced by `publicBillingConfig`.
- **Keep it dependency-light.** The app runs on Node.js ≥ 24 with built-ins
  (`fetch`, `URLSearchParams`, `node --test`). Add a dependency only when there
  is no reasonable built-in path.

## Development setup

```bash
npm test        # node --test
npm run lint    # node --check on all source files
npm run dev     # start the server on http://localhost:3000
```

The hosted billing flow stays disabled by default; copy `.env.sample` to `.env`
to experiment locally. You do **not** need Stripe configured to run the app —
billing degrades safely to contact-sales / open-source states.

## Pull requests

1. Fork and create a topic branch.
2. Make your change with a focused diff. Match the surrounding code style.
3. Add or update tests. `npm test` and `npm run lint` must pass.
4. If you touch pricing, plan limits, or feature copy, keep
   `test/billing.test.js` green — it asserts that marketing copy matches the
   enforced limits and that no secrets leak into the browser projection.
5. Open a PR describing the change and the verification you ran.

## Frontend changes

The browser UI builds DOM via `textContent` and `createElement` — **never use
`innerHTML`**. Keep markup accessible (labels, `aria-*`, focus order) and
consistent with the existing terminal/spec aesthetic.

## Reporting bugs and security issues

- Functional bugs: open a GitHub issue with steps to reproduce.
- Security vulnerabilities: **do not** open a public issue — follow
  [`SECURITY.md`](SECURITY.md).

## License of contributions

By contributing, you agree that your contributions are licensed under the MIT
License that covers the project.
