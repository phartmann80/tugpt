# Phase 3A: Secure Asynchronous Inbound-Message Foundation

Branch: `feature/phase3a-webhook-foundation`

## Scope built in this PR

Webhook signature verification, event normalization, metadata-only
replay-protected receipts, server-only content staging, atomic
receipt/staging/pgmq ingestion, receipt-derived tenant processing, atomic
dead-lettering, PgMqJobQueue, and a dedicated worker.
No AI draft generation, no live provider calls, no outbound WhatsApp
sending, no dashboard UI, no billing, no ai_usage_events, no real secrets
backend, per the authorized scope.

## Verified in this sandbox (forced, no cache)

| Command | Exit | Packages |
|---|---|---|
| lint --force | 0 | 9/9 |
| typecheck --force | 0 | 9/9 |
| test --force | 0 | 7/7 packages with tests, 95 JS/TS assertions |
| build --force | 0 | 1/1 (web) |

All commands were force-executed, not served from Turbo cache.

## pgTAP: executed in isolated CI

GitHub Actions run
[#10](https://github.com/phartmann80/tugpt/actions/runs/29964287534)
started a clean local Supabase database, applied both migrations, and ran
all database suites successfully.

```text
supabase/tests/database/invitations_and_ownership.test.sql .. ok (10)
supabase/tests/database/rls_adversarial.test.sql ............ ok (35)
supabase/tests/database/webhook_foundation_rls.test.sql ..... ok (47)
All tests successful.
Files=3, Tests=92
Result: PASS
```

## Coverage of the new suite

RLS/FORCE RLS across all 7 new tables; explicit client denial for the 3
server-only tables and RPCs; metadata/PII column separation; authoritative
connection-to-tenant resolution; atomic receipt/staging/queue ingestion;
replay protection; minimal queue payload; atomic worker persistence;
conversation escalation-state preservation; idempotent worker redelivery;
client-visible tenant isolation; atomic dead-letter persistence/archive; and
rejection of tampered cross-tenant staging identity.

## Optional local reproduction

```powershell
git fetch origin
git checkout feature/phase3a-webhook-foundation
pnpm install --frozen-lockfile
pnpm exec supabase stop
pnpm exec supabase db reset
pnpm exec supabase test db
```

## Not performed in this PR

AI draft generation, live provider calls, outbound WhatsApp sending,
dashboard UI, subscriptions/billing, ai_usage_events, a real secrets
backend, deployment, or production Supabase changes.

## Findings during this PR (not requested, reported for transparency)

- apps/web/package.json declared @tugpt/ai-providers as a dependency
  before this PR, unused by any file in apps/web/src. Removed it.
- apps/worker's tsx dependency pulls in esbuild as a new pnpm-ignored
  build script (inspected, not approved: it only links the correct
  prebuilt native binary, same pattern as sharp/unrs-resolver).
