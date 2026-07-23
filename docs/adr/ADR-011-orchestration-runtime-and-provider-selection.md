# ADR-011: Orchestration Runtime and Provider Selection

## Status
Accepted for synchronous text-completion routing

## Context
Phase 2 established a thin `AIProviderAdapter` contract (ADR-006) covering only
`generateCompletion`. Phase 3 introduces a real orchestration layer that must
decide which provider handles a given request, how failures are handled, and
how usage is recorded -- without collapsing that decision-making into the
adapters themselves.

TuGPT.ai has three inference-provider integrations: **Logicc** (primary),
**Langdock** (explicit fallback only), and **OpenAI** (available only when
explicitly selected). A legacy Mastra-as-adapter implementation predated this ADR.
Provider selection must never be inferred from which credentials happen to be
present in the environment -- that has previously caused ambiguous, silent
routing decisions and is explicitly disallowed here.

## Decision

1. **Mastra is the orchestration runtime, not an inference-provider peer.**
   Earlier documentation (and `packages/ai-providers/src/mastra.ts`) treated
   Mastra as one adapter among several implementing `generateCompletion`.
   This ADR corrects that: Mastra is the layer that assembles prompts, threads
   conversation state, decides whether a tool/function call is needed, and
   selects which underlying inference adapter actually executes a completion.
   Phase 3B removes the legacy `MastraAdapter` and registers the routing workflow
   in `@mastra/core`. Mastra therefore cannot be selected as an inference provider.

2. **Explicit provider selection, never credential-presence-based.**
   Two environment variables are authoritative:
   ```
   AI_TEXT_PRIMARY_PROVIDER=logicc
   AI_TEXT_FALLBACK_PROVIDER=langdock
   ```
   The orchestration runtime reads both at startup. A provider is only ever
   selected if its name appears in one of these two variables. The mere
   presence of `LANGDOCK_API_KEY`, `OPENAI_API_KEY`, or any other credential
   in the environment does **not** make that provider eligible for selection.
   If a named provider's adapter is not registered (e.g. credentials missing
   despite being named), the orchestration runtime fails closed with a
   `no_provider_configured` normalized error (see item 6) rather than silently
   trying an unnamed provider.

3. **Logicc is the primary provider.** `LogiccAdapter` implements the existing
   `AIProviderAdapter.generateCompletion()` interface against Logicc's documented
   OpenAI-compatible Chat Completions endpoint. Tests use an injected transport;
   no live credential is required by the implementation or CI.

4. **Langdock is fallback-only, and only when explicitly configured.**
   `LangdockAdapter` is only invoked by the orchestration runtime when
   `AI_TEXT_FALLBACK_PROVIDER=langdock` is set, and only after the primary
   provider call has failed. It is never a silent default.

5. **OpenAI is not selected by default under any configuration.** The
   `OpenAIAdapter` remains in the codebase (ADR-006 already covers it as an
   implemented adapter) but is only reachable if a future configuration
   explicitly names `openai` in one of the two selection variables above --
   which is not the current default configuration.

6. **Timeout, cancellation, and failure normalization.** The orchestration
   runtime wraps every `generateCompletion` call with an explicit,
   caller-controlled cancellation signal (see the companion update to
   ADR-006 for how the adapter contract itself gains real `AbortSignal`
   support) and a timeout. Provider-specific errors are mapped to a closed
   set before reaching any caller: `timeout`, `rate_limited`,
   `provider_error`, `invalid_response`, `no_provider_configured`. No
   provider SDK exception type is ever allowed to propagate past the
   orchestration boundary.

7. **Usage metadata.** Every attempted completion produces bounded attempt
   metadata (provider, model, latency, outcome, normalized error, and token usage
   when available). Adapters also emit the existing observability metric. Durable
   `ai_usage_events` persistence is required in the worker integration slice
   before production traffic is enabled.

8. **Durable runtime state is mandatory.** Runtime construction requires a
   Mastra storage adapter. Tests inject Mastra's in-memory test store; production
   code cannot silently accept Mastra's non-durable default.

## Consequences
- Provider selection is auditable and reproducible from two environment
  variables alone -- no hidden precedence rules based on which secrets exist.
- Logicc uses the existing thin adapter contract without expanding it.
- Mastra's role is unambiguous: orchestration, not transport. The legacy
  `MastraAdapter` has been removed.

## Security Implications
- The explicit-configuration requirement prevents an operator from accidentally
  activating a provider merely by placing its API key in the environment.
- Provider credentials stay inside server-only adapter instances and are never
  included in workflow input, output, attempt metadata, or error messages.
