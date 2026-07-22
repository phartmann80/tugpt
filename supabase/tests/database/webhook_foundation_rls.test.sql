-- TuGPT.ai pgTAP Phase 3A Webhook Foundation Test Suite
-- Runs inside one transaction and rolls back every fixture/queue operation.
BEGIN;
SELECT plan(47);

INSERT INTO auth.users (
  instance_id, id, aud, role, email,
  encrypted_password, email_confirmed_at,
  created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data,
  is_super_admin, confirmation_token, recovery_token,
  email_change_token_new, email_change
) VALUES
  ('00000000-0000-0000-0000-000000000000','a1111111-1111-1111-1111-111111111111',
   'authenticated','authenticated','owner_wh_a@tugpt.ai','',
   '2026-01-01','2026-01-01','2026-01-01','{}','{}',false,'','','',''),
  ('00000000-0000-0000-0000-000000000000','b2222222-2222-2222-2222-222222222222',
   'authenticated','authenticated','owner_wh_b@tugpt.ai','',
   '2026-01-01','2026-01-01','2026-01-01','{}','{}',false,'','','','')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organizations (id, name, slug) VALUES
  ('c3333333-3333-3333-3333-333333333333','Webhook Tenant A','webhook-tenant-a'),
  ('d4444444-4444-4444-4444-444444444444','Webhook Tenant B','webhook-tenant-b')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  ('c3333333-3333-3333-3333-333333333333','a1111111-1111-1111-1111-111111111111','owner'),
  ('d4444444-4444-4444-4444-444444444444','b2222222-2222-2222-2222-222222222222','owner')
ON CONFLICT (organization_id, user_id) DO NOTHING;

INSERT INTO public.whatsapp_connections (
  id, organization_id, phone_number_id, waba_id, display_phone_number, status
) VALUES
  ('e5555555-5555-5555-5555-555555555555','c3333333-3333-3333-3333-333333333333',
   'pn-a-001','waba-a-001','+10000000001','connected'),
  ('f6666666-6666-6666-6666-666666666666','d4444444-4444-4444-444444444444',
   'pn-b-001','waba-b-001','+10000000002','connected')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.business_profiles (id, organization_id, business_name) VALUES
  ('11110000-0000-0000-0000-000000000001','c3333333-3333-3333-3333-333333333333','Tenant A Biz'),
  ('22220000-0000-0000-0000-000000000002','d4444444-4444-4444-4444-444444444444','Tenant B Biz')
ON CONFLICT (id) DO NOTHING;

-- Existing escalated conversation: processing must reuse it without reopening.
INSERT INTO public.conversations (
  id, organization_id, whatsapp_connection_id, contact_wa_id, status
) VALUES (
  '33330000-0000-0000-0000-000000000003',
  'c3333333-3333-3333-3333-333333333333',
  'e5555555-5555-5555-5555-555555555555',
  'contact-a',
  'needs_human'
);

-- ---------------------------------------------------------------------------
-- Schema and privilege boundary
-- ---------------------------------------------------------------------------

SELECT is(
  (SELECT COUNT(*)::int FROM pg_class
   WHERE oid IN (
     'public.business_profiles'::regclass,
     'public.whatsapp_connections'::regclass,
     'public.webhook_events'::regclass,
     'public.inbound_message_staging'::regclass,
     'public.conversations'::regclass,
     'public.messages'::regclass,
     'public.failed_jobs'::regclass
   ) AND relrowsecurity),
  7,
  'Test 1: RLS is enabled on all seven Phase 3A tables'
);

SELECT is(
  (SELECT COUNT(*)::int FROM pg_class
   WHERE oid IN (
     'public.business_profiles'::regclass,
     'public.whatsapp_connections'::regclass,
     'public.webhook_events'::regclass,
     'public.inbound_message_staging'::regclass,
     'public.conversations'::regclass,
     'public.messages'::regclass,
     'public.failed_jobs'::regclass
   ) AND relforcerowsecurity),
  7,
  'Test 2: FORCE RLS is enabled on all seven Phase 3A tables'
);

SELECT is(
  (SELECT COUNT(*)::int FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('webhook_events', 'inbound_message_staging', 'failed_jobs')),
  0,
  'Test 3: server-only tables have no client-facing RLS policies'
);

SELECT ok(
  NOT has_table_privilege('authenticated', 'public.webhook_events', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.inbound_message_staging', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'public.failed_jobs', 'SELECT'),
  'Test 4: authenticated has no direct read privilege on server-only tables'
);

SELECT ok(
  NOT has_table_privilege('anon', 'public.webhook_events', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.inbound_message_staging', 'SELECT')
  AND NOT has_table_privilege('anon', 'public.failed_jobs', 'SELECT'),
  'Test 5: anon has no direct read privilege on server-only tables'
);

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.ingest_whatsapp_message_event(text,text,text,text,text,text,text)',
    'EXECUTE'
  ),
  'Test 6: authenticated cannot execute atomic ingestion RPC'
);

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.process_whatsapp_inbound_receipt(uuid)',
    'EXECUTE'
  ),
  'Test 7: authenticated cannot execute atomic processing RPC'
);

SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.dead_letter_job(text,bigint,uuid,text,integer)',
    'EXECUTE'
  ),
  'Test 8: authenticated cannot execute atomic dead-letter RPC'
);

SELECT is(
  (SELECT COUNT(*)::int FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'webhook_events'
     AND column_name IN ('contact_wa_id', 'message_type', 'body_text', 'wa_timestamp', 'raw_payload')),
  0,
  'Test 9: webhook_events is metadata-only and contains no message/contact payload columns'
);

SELECT is(
  (SELECT COUNT(*)::int FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'failed_jobs'
     AND column_name IN ('payload', 'organization_id')),
  0,
  'Test 10: failed_jobs stores neither copied payload nor queue-claimed tenant identity'
);

-- ---------------------------------------------------------------------------
-- Atomic ingestion and replay protection
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE phase3a_rpc_results (
  label TEXT PRIMARY KEY,
  result JSONB NOT NULL
) ON COMMIT DROP;

INSERT INTO phase3a_rpc_results (label, result)
VALUES (
  'unknown',
  public.ingest_whatsapp_message_event(
    'pn-not-registered', 'wamid.unknown', 'contact-unknown', 'text', 'ignored', '1700000000', 'req-unknown'
  )
);

SELECT is(
  (SELECT result->>'outcome' FROM phase3a_rpc_results WHERE label = 'unknown'),
  'unknown_connection',
  'Test 11: unknown connection returns a non-writing outcome'
);

SELECT is(
  (SELECT COUNT(*)::int FROM public.webhook_events WHERE provider_event_id = 'wamid.unknown'),
  0,
  'Test 12: unknown connection creates no receipt'
);

INSERT INTO phase3a_rpc_results (label, result)
VALUES (
  'ingest-main',
  public.ingest_whatsapp_message_event(
    'pn-a-001', 'wamid.main', 'contact-a', 'text', 'Hola desde WhatsApp', '1700000001', 'req-main'
  )
);

SELECT is(
  (SELECT result->>'outcome' FROM phase3a_rpc_results WHERE label = 'ingest-main'),
  'queued',
  'Test 13: valid inbound event is atomically accepted and queued'
);

SELECT is(
  (SELECT COUNT(*)::int FROM public.webhook_events WHERE provider_event_id = 'wamid.main'),
  1,
  'Test 14: valid ingestion creates exactly one receipt'
);

SELECT is(
  (SELECT organization_id FROM public.webhook_events WHERE provider_event_id = 'wamid.main'),
  'c3333333-3333-3333-3333-333333333333'::uuid,
  'Test 15: receipt organization is derived from the registered connection'
);

SELECT is(
  (SELECT whatsapp_connection_id FROM public.webhook_events WHERE provider_event_id = 'wamid.main'),
  'e5555555-5555-5555-5555-555555555555'::uuid,
  'Test 16: receipt connection is derived from phone_number_id'
);

SELECT is(
  (SELECT event_kind FROM public.webhook_events WHERE provider_event_id = 'wamid.main'),
  'message',
  'Test 17: receipt uses the consistent event_kind field'
);

SELECT is(
  (SELECT s.contact_wa_id FROM public.inbound_message_staging s
   JOIN public.webhook_events e ON e.id = s.webhook_event_id
   WHERE e.provider_event_id = 'wamid.main'),
  'contact-a',
  'Test 18: customer identity is held in server-only staging'
);

SELECT is(
  (SELECT s.body_text FROM public.inbound_message_staging s
   JOIN public.webhook_events e ON e.id = s.webhook_event_id
   WHERE e.provider_event_id = 'wamid.main'),
  'Hola desde WhatsApp',
  'Test 19: normalized message content is held in server-only staging'
);

CREATE TEMP TABLE phase3a_queue_probe ON COMMIT DROP AS
SELECT *
FROM public.pgmq_read('whatsapp_inbound_v1', 0, 20)
WHERE message->>'webhookEventId' = (
  SELECT id::text FROM public.webhook_events WHERE provider_event_id = 'wamid.main'
);

SELECT is(
  (SELECT COUNT(*)::int FROM phase3a_queue_probe),
  1,
  'Test 20: valid ingestion creates exactly one pgmq item'
);

SELECT is(
  (SELECT COUNT(*)::int FROM phase3a_queue_probe q, LATERAL jsonb_object_keys(q.message)),
  3,
  'Test 21: queue payload has only receipt ID and correlation metadata keys'
);

SELECT ok(
  (SELECT NOT (message ?| ARRAY[
    'organizationId', 'whatsappConnectionId', 'contactWaId', 'body', 'phoneNumberId', 'rawPayload'
  ]) FROM phase3a_queue_probe LIMIT 1),
  'Test 22: queue payload excludes tenant claims, customer PII, message body, and raw JSON'
);

INSERT INTO phase3a_rpc_results (label, result)
VALUES (
  'duplicate-main',
  public.ingest_whatsapp_message_event(
    'pn-a-001', 'wamid.main', 'contact-a', 'text', 'Replay body', '1700000001', 'req-replay'
  )
);

SELECT is(
  (SELECT result->>'outcome' FROM phase3a_rpc_results WHERE label = 'duplicate-main'),
  'duplicate',
  'Test 23: repeated provider event is reported as a duplicate'
);

SELECT is(
  (SELECT COUNT(*)::int FROM public.webhook_events WHERE provider_event_id = 'wamid.main'),
  1,
  'Test 24: replay creates no second receipt'
);

SELECT is(
  (SELECT COUNT(*)::int FROM public.inbound_message_staging s
   JOIN public.webhook_events e ON e.id = s.webhook_event_id
   WHERE e.provider_event_id = 'wamid.main'),
  1,
  'Test 25: replay creates no second staging row'
);

CREATE TEMP TABLE phase3a_queue_after_duplicate ON COMMIT DROP AS
SELECT *
FROM public.pgmq_read('whatsapp_inbound_v1', 0, 20)
WHERE message->>'webhookEventId' = (
  SELECT id::text FROM public.webhook_events WHERE provider_event_id = 'wamid.main'
);

SELECT is(
  (SELECT COUNT(*)::int FROM phase3a_queue_after_duplicate),
  1,
  'Test 26: replay creates no second queue item'
);

-- ---------------------------------------------------------------------------
-- Atomic worker processing and status safety
-- ---------------------------------------------------------------------------

INSERT INTO phase3a_rpc_results (label, result)
SELECT 'process-main', public.process_whatsapp_inbound_receipt(id)
FROM public.webhook_events
WHERE provider_event_id = 'wamid.main';

SELECT is(
  (SELECT result->>'outcome' FROM phase3a_rpc_results WHERE label = 'process-main'),
  'processed',
  'Test 27: worker RPC processes the staged receipt atomically'
);

SELECT is(
  (SELECT status::text FROM public.conversations
   WHERE whatsapp_connection_id = 'e5555555-5555-5555-5555-555555555555'
     AND contact_wa_id = 'contact-a'),
  'needs_human',
  'Test 28: processing preserves an existing human-escalation conversation state'
);

SELECT is(
  (SELECT COUNT(*)::int FROM public.messages WHERE wa_message_id = 'wamid.main'),
  1,
  'Test 29: processing creates exactly one inbound message'
);

SELECT is(
  (SELECT body FROM public.messages WHERE wa_message_id = 'wamid.main'),
  'Hola desde WhatsApp',
  'Test 30: message body comes from authoritative staging'
);

SELECT is(
  (SELECT organization_id FROM public.messages WHERE wa_message_id = 'wamid.main'),
  'c3333333-3333-3333-3333-333333333333'::uuid,
  'Test 31: message tenant identity comes from the receipt, not a queue claim'
);

SELECT is(
  (SELECT status::text FROM public.webhook_events WHERE provider_event_id = 'wamid.main'),
  'processed',
  'Test 32: successful processing marks the receipt processed'
);

SELECT is(
  (SELECT COUNT(*)::int FROM public.inbound_message_staging s
   JOIN public.webhook_events e ON e.id = s.webhook_event_id
   WHERE e.provider_event_id = 'wamid.main'),
  0,
  'Test 33: successful processing removes temporary staged content'
);

INSERT INTO phase3a_rpc_results (label, result)
SELECT 'process-main-again', public.process_whatsapp_inbound_receipt(id)
FROM public.webhook_events
WHERE provider_event_id = 'wamid.main';

SELECT is(
  (SELECT result->>'outcome' FROM phase3a_rpc_results WHERE label = 'process-main-again'),
  'already_processed',
  'Test 34: worker redelivery is an idempotent success'
);

SELECT is(
  (SELECT COUNT(*)::int FROM public.messages WHERE wa_message_id = 'wamid.main'),
  1,
  'Test 35: worker redelivery creates no duplicate message'
);

-- Tenant A sees only its own client-visible conversation data.
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"a1111111-1111-1111-1111-111111111111","role":"authenticated"}',
  true
);
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT COUNT(*)::int FROM public.conversations
   WHERE organization_id = 'd4444444-4444-4444-4444-444444444444'),
  0,
  'Test 36: tenant A cannot read tenant B conversations'
);

RESET ROLE;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
SET LOCAL ROLE anon;

SELECT is(
  (SELECT COUNT(*)::int FROM public.conversations),
  0,
  'Test 37: anon reads zero conversations through RLS'
);

RESET ROLE;

-- ---------------------------------------------------------------------------
-- Atomic dead-lettering
-- ---------------------------------------------------------------------------

INSERT INTO phase3a_rpc_results (label, result)
VALUES (
  'ingest-dead',
  public.ingest_whatsapp_message_event(
    'pn-a-001', 'wamid.dead', 'contact-dead', 'text', 'dead letter body', '1700000002', 'req-dead'
  )
);

SELECT is(
  (SELECT result->>'outcome' FROM phase3a_rpc_results WHERE label = 'ingest-dead'),
  'queued',
  'Test 38: dead-letter fixture is queued atomically'
);

CREATE TEMP TABLE phase3a_dead_queue_probe ON COMMIT DROP AS
SELECT *
FROM public.pgmq_read('whatsapp_inbound_v1', 0, 20)
WHERE message->>'webhookEventId' = (
  SELECT id::text FROM public.webhook_events WHERE provider_event_id = 'wamid.dead'
);

SELECT ok(
  public.dead_letter_job(
    'whatsapp_inbound_v1',
    (SELECT msg_id FROM phase3a_dead_queue_probe LIMIT 1),
    (SELECT id FROM public.webhook_events WHERE provider_event_id = 'wamid.dead'),
    'worker failed safely',
    5
  ),
  'Test 39: dead-letter row and pgmq archive commit through one RPC'
);

SELECT is(
  (SELECT COUNT(*)::int FROM public.failed_jobs f
   JOIN public.webhook_events e ON e.id = f.webhook_event_id
   WHERE e.provider_event_id = 'wamid.dead'),
  1,
  'Test 40: exhausted job creates exactly one narrow failed_jobs row'
);

SELECT is(
  (SELECT attempts FROM public.failed_jobs f
   JOIN public.webhook_events e ON e.id = f.webhook_event_id
   WHERE e.provider_event_id = 'wamid.dead'),
  5,
  'Test 41: failed_jobs records bounded diagnostics and attempt count'
);

SELECT is(
  (SELECT status::text FROM public.webhook_events WHERE provider_event_id = 'wamid.dead'),
  'failed',
  'Test 42: dead-lettering marks an unprocessed receipt failed'
);

CREATE TEMP TABLE phase3a_dead_queue_after ON COMMIT DROP AS
SELECT *
FROM public.pgmq_read('whatsapp_inbound_v1', 0, 20)
WHERE message->>'webhookEventId' = (
  SELECT id::text FROM public.webhook_events WHERE provider_event_id = 'wamid.dead'
);

SELECT is(
  (SELECT COUNT(*)::int FROM phase3a_dead_queue_after),
  0,
  'Test 43: dead-lettered pgmq item is no longer active'
);

-- ---------------------------------------------------------------------------
-- Authoritative tenant mismatch rejection
-- ---------------------------------------------------------------------------

INSERT INTO phase3a_rpc_results (label, result)
VALUES (
  'ingest-mismatch',
  public.ingest_whatsapp_message_event(
    'pn-a-001', 'wamid.mismatch', 'contact-mismatch', 'text', 'must not cross tenant', '1700000003', 'req-mismatch'
  )
);

SELECT is(
  (SELECT result->>'outcome' FROM phase3a_rpc_results WHERE label = 'ingest-mismatch'),
  'queued',
  'Test 44: mismatch fixture starts from a valid atomic ingestion'
);

UPDATE public.inbound_message_staging
SET organization_id = 'd4444444-4444-4444-4444-444444444444'
WHERE webhook_event_id = (
  SELECT id FROM public.webhook_events WHERE provider_event_id = 'wamid.mismatch'
);

SELECT throws_ok(
  $$SELECT public.process_whatsapp_inbound_receipt(
      (SELECT id FROM public.webhook_events WHERE provider_event_id = 'wamid.mismatch')
    )$$,
  '22023',
  NULL,
  'Test 45: processing rejects staging whose tenant identity differs from the receipt'
);

SELECT is(
  (SELECT COUNT(*)::int FROM public.messages WHERE wa_message_id = 'wamid.mismatch'),
  0,
  'Test 46: rejected tenant mismatch creates no message'
);

SELECT is(
  (SELECT status::text FROM public.webhook_events WHERE provider_event_id = 'wamid.mismatch'),
  'received',
  'Test 47: rejected tenant mismatch does not corrupt receipt state'
);

SELECT * FROM finish();
ROLLBACK;
