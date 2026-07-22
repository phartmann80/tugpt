# ADR-006: Provider Adapter Architecture

## Status
Provisional (Subject to Composable Capability-Based Review)

## Context
TuGPT.ai will integrate with multiple AI providers (OpenAI, Langdock, Mastra). We need a unified interface that abstracts vendor-specific SDK differences and prevents vendor lock-in.

## Decision
1. Current Contract (implemented): `AIProviderAdapter` in `@tugpt/ai-providers` currently
   exposes a single method:
   - `generateCompletion(messages, options)`
   This is intentionally minimal and covers only synchronous chat completion. It does
   **not** yet cover streaming, embeddings, or any other capability — those are not
   implemented and must not be assumed present by callers.
2. Implementation Adapters:
   - `OpenAIAdapter`: Direct OpenAI API wrapper.
   - `LangdockAdapter`: Langdock AI orchestration API wrapper.
   - `MastraAdapter`: Mastra AI framework adapter.
   All three currently implement only `generateCompletion`.
3. Factory Pattern: `AIProviderFactory.getAdapter(providerName)` resolves and instantiates the appropriate adapter based on organization configuration and feature flags.
4. Authorization Constraint: Live production API calls to external AI providers remain disabled until Phase 3 authorization.
5. Real Cancellation (Phase 3A): `CompletionOptions` gains an optional
   `signal?: AbortSignal`. Adapters that perform a network call MUST pass this
   signal through to the underlying transport (e.g. `fetch`'s own `signal`
   option) so an aborted orchestration-level timeout or shutdown actually
   cancels the in-flight request rather than merely abandoning a promise.
   This is a contract addition, not a capability expansion — it does not
   imply streaming, tool calls, or any other item in the list below. Phase 3A
   introduces no live provider calls; no adapter's network path is exercised
   as part of this change, only the interface shape.
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
- Allows seamless fallback or routing between AI providers for that capability.
- Expanding to the capabilities listed above requires revisiting this ADR; the current
  contract must not be treated as final or "frozen" until that review happens and the
  status is explicitly updated to Accepted.

## Security Implications
- API keys stored securely in server environment/vault and never exposed to client bundles.
- Token counts and latency recorded via `@tugpt/observability`.
