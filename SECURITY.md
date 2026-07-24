# Security Policy

BaseMouse handles your documents and issues API credentials, so we take security
seriously. Thank you for helping keep the project and its users safe.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, email **devsupport@meshai.dev** with:

- A description of the issue and its impact.
- Steps to reproduce (proof-of-concept if possible).
- Affected version / commit, and whether it is the hosted service
  (basemouse.com) or a self-hosted deployment.

We aim to acknowledge reports within 3 business days and to provide a remediation
timeline after triage. Please give us a reasonable window to ship a fix before
any public disclosure.

## Scope

In scope:

- The application code in this repository (API, retrieval, history, billing
  glue, static UI).
- The self-hosted deployment artifacts (`Dockerfile`, `deployment/`).

Out of scope:

- Third-party services we integrate with (Stripe, Slack, Ollama/vLLM/LM Studio).
  Report those to the respective vendor.
- Findings that require a compromised host or stolen credentials to exploit.

## Handling of secrets and data

- Secrets (Stripe secret/restricted keys, webhook secret, price IDs, bearer
  keys) are read from environment variables and kept server-side. The browser
  only receives the sanitized projection from `publicBillingConfig`.
- Payment data is owned by Stripe Checkout — BaseMouse never sees card details.
- API keys (`bm_…`) are stored hashed; the plaintext key is shown exactly once at
  claim time.

If you find a path where any of the above does not hold, that is a security bug —
please report it.

## Self-hosted deployments

When self-hosting, follow the hardening guidance in
[`docs/self-hosted.md`](docs/self-hosted.md): expose the API on internal
networks only, use bearer tokens or mTLS for service-to-service calls, and keep
your `.env` out of version control.
