# Phase 3B: AI Orchestration Foundation

## Status

Implementation verified locally on 2026-07-22. GitHub CI and the existing
Docker-backed pgTAP gate remain the publication checks for this branch.

Phase 3B creates the provider/orchestration boundary; it does **not** enable
live customer traffic or call any external AI provider.

## Delivered

- `LogiccAdapter` implements Logicc's documented OpenAI-compatible
  `/v1/chat/completions` contract through an injectable transport.
- Logicc, Langdock, and OpenAI share one hardened Chat Completions transport
  that forwards cancellation, validates response shape, records token/latency
  metrics once, and discards provider error bodies.
- Provider eligibility is controlled only by `AI_TEXT_PRIMARY_PROVIDER` and
  `AI_TEXT_FALLBACK_PROVIDER`. Unnamed credentials cannot activate a provider.
- `TextCompletionRouter` enforces one bounded primary attempt, optional explicit
  fallback, per-provider model selection, real transport abort, normalized
  errors, and bounded attempt metadata.
- `@tugpt/ai-orchestration` registers the router as a Mastra workflow. Runtime
  construction requires an explicit storage adapter; Mastra's unsafe implicit
  in-memory production default is not accepted.
- The legacy `MastraAdapter` inference transport is removed. Mastra is now only
  the orchestration runtime described by ADR-011.
- The CI Node runtime moves to 22.18 because Mastra 1.51 requires Node 22.13 or
  newer.

Implementation references:

- [Logicc API documentation](https://help.logicc.com/docs/integrationen-und-api/api-dokumentation)
- [Mastra workflow documentation](https://mastra.ai/docs/workflows/overview)

## Verification

All commands were executed with Turbo cache bypassed where applicable.

| Gate | Result |
|---|---|
| Lint | 10/10 tasks passed, exit 0 |
| Typecheck | 10/10 tasks passed, exit 0 |
| JavaScript/TypeScript tests | 115 tests passed, exit 0 |
| Production build | Next.js 16.2.10 build passed, exit 0 |
| New provider tests | 11 passed |
| New orchestration tests | 9 passed |
| Live provider calls | 0; all transports mocked |

The repository's 92 pgTAP assertions are unchanged by this slice and run in
GitHub Actions against an isolated local Supabase database.

## Security boundaries

- No `.env.local`, PAT, provider key, or provider response body is committed,
  logged, or returned from orchestration.
- Raw provider exceptions are not retained through `Error.cause`; callers see
  only `AIOrchestrationError` and its closed error-code set.
- Missing primary credentials fail closed and do not activate fallback.
- Workflow storage is mandatory, but choosing and configuring the production
  PostgreSQL-backed Mastra store is intentionally deferred to the worker slice.
  No production traffic may be enabled before its tenant, encryption, retention,
  and backup controls are verified.

## Next slice

Phase 3C will add durable `ai_usage_events`, configure the production Mastra
PostgreSQL store, and connect the receipt-derived WhatsApp worker to the
orchestration workflow. The worker will then enqueue an idempotent outbound
WhatsApp send; outbound delivery and status webhooks remain a separate gate.
