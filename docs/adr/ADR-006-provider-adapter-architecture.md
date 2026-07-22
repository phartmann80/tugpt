# ADR-006: Provider Adapter Architecture

## Status
Accepted for synchronous chat completion; broader capability review pending

## Context
TuGPT.ai integrates with multiple inference providers and uses Mastra as its
orchestration runtime. We need a unified transport interface that abstracts
vendor-specific API differences without confusing orchestration with inference.

## Decision
1. Current Contract (implemented): `AIProviderAdapter` in `@tugpt/ai-providers` currently
   exposes a single method:
   - `generateCompletion(messages, options)`
   This is intentionally minimal and covers only synchronous chat completion. It does
   **not** yet cover streaming, embeddings, or any other capability — those are not
   implemented and must not be assumed present by callers.
2. Implementation Adapters:
   - `LogiccAdapter`: primary OpenAI-compatible inference transport.
   - `LangdockAdapter`: explicit fallback OpenAI-compatible transport.
   - `OpenAIAdapter`: optional direct OpenAI transport when explicitly named.
   Mastra is intentionally absent from this list because it owns orchestration,
   not inference transport. All three adapters currently implement only
   `generateCompletion`.
3. Factory Pattern: `AIProviderFactory.initializeFromEnv()` registers only the
   primary and optional fallback named by `AI_TEXT_PRIMARY_PROVIDER` and
   `AI_TEXT_FALLBACK_PROVIDER`. Credentials for unnamed providers have no effect.
4. Invocation Constraint: Provider transports are invoked only through
   `@tugpt/ai-orchestration`; application code must not select adapters directly.
5. Real Cancellation: `CompletionOptions` includes an optional
   `signal?: AbortSignal`. Adapters that perform a network call MUST pass this
   signal through to the underlying transport (e.g. `fetch`'s own `signal`
   option) so an aborted orchestration-level timeout or shutdown actually
   cancels the in-flight request rather than merely abandoning a promise.
   This is a contract addition, not a capability expansion — it does not
   imply streaming, tool calls, or any other item in the list below. Logicc,
   Langdock, and OpenAI share a hardened transport that forwards this signal.
6. Pending Capability Review: the architecture remains **provisional** because the full
   provider contract has not yet been designed. A future capability-based review must
   cover, at minimum:
   - Chat
   - Streaming
   - Structured output
   - Tool-call requests
   - Embeddings
   - Image generation
   - Video jobs
   - Speech-to-text
   - Text-to-speech
   - Timeouts
   - Retry policy
   - Error normalization
   - Usage and cost reporting
   - Model-level capability discovery
   Application tools (function/tool-calling) must be executed by the orchestration layer,
   never directly by a provider adapter — adapters stay thin transport wrappers.
   See ADR-011 for how Mastra fits this boundary as the orchestration runtime,
   not as an adapter peer.

## Consequences
- Single decoupled interface for the one capability implemented so far (chat completion).
- Allows explicit, tested fallback between inference providers for that capability.
- Expanding to the capabilities listed above requires revisiting this ADR; the current
  contract must not be treated as final or "frozen" until that review happens and the
  synchronous text-completion slice must not be mistaken for those capabilities.

## Security Implications
- API keys stored securely in server environment/vault and never exposed to client bundles.
- Provider error bodies are discarded at the adapter boundary because they can
  contain customer content or vendor diagnostics.
- Token counts and latency recorded via `@tugpt/observability`.
