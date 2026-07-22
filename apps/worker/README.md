# @tugpt/worker

Dedicated Node worker process. Introduced in Phase 3A as the **only**
permitted consumer of the `whatsapp_inbound_v1` Supabase Queue (pgmq).

## Execution boundary (do not violate)

- `apps/web`'s webhook route (`/api/v1/webhooks/whatsapp`) may only
  call the atomic `PgMqJobQueue.ingestWhatsAppMessageEvent()` boundary. It
  must never insert receipts directly, call the legacy generic `enqueue()`
  path for WhatsApp, or call `poll()`, `ackSuccess()`, or `ackFailure()`.
- This worker may never generate an AI reply, call Mastra, Logicc,
  Langdock, OpenAI, or any provider adapter. It stops at persisting the
  inbound conversation/message and marking the webhook receipt processed.
  See `docs/adr/ADR-011-orchestration-runtime-and-provider-selection.md`
  for where AI orchestration is planned to live in a later Phase 3 slice --
  not here.
- Queue payloads contain only `webhookEventId` and correlation metadata
  (`WhatsAppInboundJobPayload`). Tenant identity is derived from the locked
  receipt inside `process_whatsapp_inbound_receipt`; queue-supplied tenant
  claims are never trusted. Message bodies, access tokens, phone-number PII,
  and raw webhook JSON must never be placed on the queue.

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
