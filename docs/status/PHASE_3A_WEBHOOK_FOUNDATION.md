# Phase 3A: Secure Asynchronous Inbound-Message Foundation

Branch: `feature/phase3a-webhook-foundation`

## Scope built in this PR

Webhook signature verification, event normalization, replay-protected
receipt ledger, PgMqJobQueue, and a dedicated worker.
No AI draft generation, no live provider calls, no outbound WhatsApp
sending, no dashboard UI, no billing, no ai_usage_events, no real secrets
backend, per the authorized scope.

## Verified in this sandbox (forced, no cache)

| Command | Exit | Packages |
|---|---|---|
| lint --force | 0 | 9/9 |
| typecheck --force | 0 | 9/9 |
| test --force | 0 | 9/9, 85 JS/TS assertions |
| build --force | 0 | 1/1 (web) |

All commands were force-executed, not served from Turbo cache.

## pgTAP: structurally inspected, execution pending

This sandbox has no Docker access. The new suite was not executed here.

```text
File: supabase/tests/database/webhook_foundation_rls.test.sql
plan(14), 14 assertions counted -- matches exactly

Existing suites, unmodified by this PR:
supabase/tests/database/invitations_and_ownership.test.sql -- plan(10), 10 assertions
supabase/tests/database/rls_adversarial.test.sql -- plan(35), 35 assertions

Combined total after this PR: 59 pgTAP assertions across 3 files.
```

## Coverage of the new suite

RLS isolation across all 5 new tables, replay-protection uniqueness on
webhook_events, idempotency uniqueness on messages, cross-tenant write
blocking on business_profiles, whatsapp_connections, conversations, and
messages, and an explicit check that RLS is enabled on all 5 tables.

## Commands for Paul's Windows machine

```powershell
git fetch origin
git checkout feature/phase3a-webhook-foundation
pnpm install --frozen-lockfile
pnpm exec supabase stop
pnpm exec supabase db reset
pnpm exec supabase test db
```

Do not claim this passes until Paul reports the actual `db reset` and
`test db` output from that run.

## Not performed in this PR

AI draft generation, live provider calls, outbound WhatsApp sending,
dashboard UI, subscriptions/billing, ai_usage_events, a real secrets
backend, deployment, production Supabase changes, merge into main, or
tag creation.

## Findings during this PR (not requested, reported for transparency)

- apps/web/package.json declared @tugpt/ai-providers as a dependency
  before this PR, unused by any file in apps/web/src. Removed it.
- apps/worker's tsx dependency pulls in esbuild as a new pnpm-ignored
  build script (inspected, not approved: it only links the correct
  prebuilt native binary, same pattern as sharp/unrs-resolver).
