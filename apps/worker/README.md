# @tugpt/worker

Dedicated Node worker process. Introduced in Phase 3A as the **only**
permitted consumer of the `whatsapp_inbound_v1` Supabase Queue (pgmq).

## Execution boundary (do not violate)

- `apps/web`'s webhook route (`/api/v1/webhooks/whatsapp`) may only
  **enqueue** (`PgMqJobQueue.enqueue`). It must never call `poll()`,
  `ackSuccess()`, or `ackFailure()` -- those exist only for this worker
  process.
- This worker may never generate an AI reply, call Mastra, Logicc,
  Langdock, OpenAI, or any provider adapter. It stops at persisting the
  inbound conversation/message and marking the webhook receipt processed.
  See `docs/adr/ADR-011-orchestration-runtime-and-provider-selection.md`
  for where AI orchestration is planned to live in a later Phase 3 slice --
  not here.
- Queue payloads it reads and produces contain only IDs and correlation
  metadata (`WhatsAppInboundJobPayload`). It must never write a message
  body, access token, phone-number PII, or raw webhook JSON onto the queue.

## Running locally

```bash
pnpm --filter @tugpt/worker start
```

Requires `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the
environment (same admin credentials used by `apps/web`'s webhook route).

## Not authorized in Phase 3A

- AI draft generation
- Outbound WhatsApp sending
- Live provider calls of any kind
