# ADR-011: Orchestration Runtime and Provider Selection

## Status
Provisional (depends on ADR-006; both remain provisional together)

## Context
Phase 2 established a thin `AIProviderAdapter` contract (ADR-006) covering only
`generateCompletion`. Phase 3 introduces a real orchestration layer that must
decide which provider handles a given request, how failures are handled, and
how usage is recorded -- without collapsing that decision-making into the
adapters themselves.

TuGPT.ai has three provider integrations planned: **Logicc** (primary
inference candidate), **Langdock** (explicit fallback only), and legacy
adapters for **OpenAI** and **Mastra**-as-adapter that predate this ADR.
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
   The existing `MastraAdapter` class name is misleading under this model and
   should be renamed/repurposed in a later Phase 3 slice (not in Phase 3A) to
   reflect "Mastra orchestration client" rather than "Mastra as one of three
   interchangeable providers." No renaming is performed in Phase 3A.

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

3. **Logicc is the primary provider candidate.** A `LogiccAdapter` will
   implement the existing `AIProviderAdapter.generateCompletion()` interface
   (added in a later Phase 3 slice; ADR-006's contract is unchanged by this
   requirement). No live Logicc calls or credentials are introduced by this
   ADR or by Phase 3A.

4. **Langdock is fallback-only, and only when explicitly configured.**
   `LangdockAdapter` is only invoked by the orchestration runtime when
   `AI_TEXT_FALLBACK_PROVIDER=langdock` is set, and only after the primary
   provider call has failed. It is never a silent default.

5. **OpenAI is not selected by default under any configuration.** The
   `OpenAIAdapter` remains in the codebase (ADR-006 already covers it as an
   implemented adapter) but is only reachable if a future configuration
   explicitly names `openai` in one of the two selection variables above --
   which is not the current configuration and is not enabled by Phase 3A.

6. **Timeout, cancellation, and failure normalization.** The orchestration
   runtime wraps every `generateCompletion` call with an explicit,
   caller-controlled cancellation signal (see the companion update to
   ADR-006 for how the adapter contract itself gains real `AbortSignal`
   support) and a timeout. Provider-specific errors are mapped to a closed
   set before reaching any caller: `timeout`, `rate_limited`,
   `provider_error`, `invalid_response`, `no_provider_configured`. No
   provider SDK exception type is ever allowed to propagate past the
   orchestration boundary.

7. **Usage metadata.** Every attempted completion call (successful or not)
   is expected to produce a usage/metadata record (provider used, model,
   token counts, latency, outcome) for later metering. The concrete
   `ai_usage_events` table is explicitly deferred past Phase 3A (see the
   Phase 3A implementation evidence) -- this ADR fixes the *requirement*,
   not the schema, which will be introduced in the slice that actually wires
   a live provider call.

## Consequences
- Provider selection is auditable and reproducible from two environment
  variables alone -- no hidden precedence rules based on which secrets exist.
- Adding Logicc does not require touching the adapter interface; it is a
  new implementation of the existing thin contract.
- Mastra's role is now unambiguous: orchestration, not transport. Any code
  that currently treats `MastraAdapter` as a peer of `OpenAIAdapter` /
  `LangdockAdapter` for the purpose of *selection* is now understood to be
  legacy and will be revisited when Mastra orchestration is actually wired
  in (not part of Phase 3A, which introduces no live provider calls at all).

## Security Implications
- No credentials are read, validated, or exercised by this ADR or by
  Phase 3A. The explicit-configuration requirement is itself a security
  control: it prevents an operator from accidentally activating a fallback
  provider merely by having its API key present in `.env`.
