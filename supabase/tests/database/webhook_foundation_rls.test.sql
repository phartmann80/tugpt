-- TuGPT.ai pgTAP Phase 3A Webhook Foundation Test Suite
-- Runs inside a single transaction that is rolled back at the end.
BEGIN;
SELECT plan(14);
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

INSERT INTO public.whatsapp_connections (id, organization_id, phone_number_id, waba_id, display_phone_number, status) VALUES
  ('e5555555-5555-5555-5555-555555555555','c3333333-3333-3333-3333-333333333333','pn-a-001','waba-a-001','+10000000001','connected'),
  ('f6666666-6666-6666-6666-666666666666','d4444444-4444-4444-4444-444444444444','pn-b-001','waba-b-001','+10000000002','connected')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.business_profiles (id, organization_id, business_name) VALUES
  ('11110000-0000-0000-0000-000000000001','c3333333-3333-3333-3333-333333333333','Tenant A Biz'),
  ('22220000-0000-0000-0000-000000000002','d4444444-4444-4444-4444-444444444444','Tenant B Biz')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.conversations (id, organization_id, whatsapp_connection_id, contact_wa_id) VALUES
  ('33330000-0000-0000-0000-000000000003','c3333333-3333-3333-3333-333333333333',
   'e5555555-5555-5555-5555-555555555555','+19999999901'),
  ('44440000-0000-0000-0000-000000000004','d4444444-4444-4444-4444-444444444444',
   'f6666666-6666-6666-6666-666666666666','+19999999902')
ON CONFLICT (id) DO NOTHING;

-- TEST 1: Tenant A cannot see Tenant B's business_profiles
SELECT set_config('request.jwt.claims',
  '{"sub":"a1111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT is(
  (SELECT COUNT(*)::int FROM public.business_profiles WHERE organization_id = 'd4444444-4444-4444-4444-444444444444'),
  0,
  'Test 1: Tenant A cannot see Tenant B business_profiles'
);

-- TEST 2: Tenant A can see own business_profiles
SELECT is(
  (SELECT COUNT(*)::int FROM public.business_profiles WHERE organization_id = 'c3333333-3333-3333-3333-333333333333'),
  1,
  'Test 2: Tenant A can see own business_profiles'
);

-- TEST 3: Tenant A cannot see Tenant B's whatsapp_connections
SELECT is(
  (SELECT COUNT(*)::int FROM public.whatsapp_connections
   WHERE organization_id = 'd4444444-4444-4444-4444-444444444444'),
  0,
  'Test 3: Tenant A cannot see Tenant B whatsapp_connections'
);

-- TEST 4: Tenant A cannot see Tenant B's conversations
SELECT is(
  (SELECT COUNT(*)::int FROM public.conversations
   WHERE organization_id = 'd4444444-4444-4444-4444-444444444444'),
  0,
  'Test 4: Tenant A cannot see Tenant B conversations'
);

-- TEST 5: Tenant A can see own conversations
SELECT is(
  (SELECT COUNT(*)::int FROM public.conversations
   WHERE organization_id = 'c3333333-3333-3333-3333-333333333333'),
  1,
  'Test 5: Tenant A can see own conversations'
);

-- TEST 6: Tenant A cannot insert a message into Tenant B's conversation
SELECT throws_ok(
  $$INSERT INTO public.messages (conversation_id, organization_id, direction, status, wa_message_id)
   VALUES ('44440000-0000-0000-0000-000000000004','d4444444-4444-4444-4444-444444444444','inbound','received','cross-tenant-msg-1')$$,
  '42501',
  NULL,
  'Test 6: Tenant A cannot insert a message into Tenant B conversation'
);

-- TEST 7: Unauthenticated user sees zero webhook_events
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
SET LOCAL ROLE anon;

SELECT is(
  (SELECT COUNT(*)::int FROM public.webhook_events),
  0,
  'Test 7: Unauthenticated user sees zero webhook_events'
);

-- TEST 8: Unauthenticated user sees zero conversations
SELECT is(
  (SELECT COUNT(*)::int FROM public.conversations),
  0,
  'Test 8: Unauthenticated user sees zero conversations'
);

RESET ROLE;

-- TEST 9: webhook_events replay protection -- duplicate (provider, event_id)

-- TEST 9: webhook_events replay protection
INSERT INTO public.webhook_events (
  id, organization_id, whatsapp_connection_id, provider, provider_event_id,
  signature_verified, event_type
) VALUES (
  'aaaa1111-0000-0000-0000-000000000001','c3333333-3333-3333-3333-333333333333',
  'e5555555-5555-5555-5555-555555555555','whatsapp','wamid.replay-test-001',
  true, 'message'
);

SELECT throws_ok(
  $$INSERT INTO public.webhook_events (
    id, organization_id, whatsapp_connection_id, provider, provider_event_id,
    signature_verified, event_type
  ) VALUES (
    'aaaa1111-0000-0000-0000-000000000002','c3333333-3333-3333-3333-333333333333',
    'e5555555-5555-5555-5555-555555555555','whatsapp','wamid.replay-test-001',
    true, 'message'
  )$$,
  '23505',
  NULL,
  'Test 9: Duplicate (provider, event_id) in webhook_events is rejected (replay protection)'
);

-- TEST 10: messages unique on (whatsapp_connection_id, wa_message_id)
-- Duplicate WhatsApp delivery must not create two inbound message rows.
INSERT INTO public.messages (
  id, conversation_id, organization_id, whatsapp_connection_id,
  direction, status, wa_message_id
) VALUES (
  'bbbb2222-0000-0000-0000-000000000001','33330000-0000-0000-0000-000000000003',
  'c3333333-3333-3333-3333-333333333333','e5555555-5555-5555-5555-555555555555',
  'inbound','received','wamid.dup-test-001'
);

SELECT throws_ok(
  $$INSERT INTO public.messages (
    id, conversation_id, organization_id, whatsapp_connection_id,
    direction, status, wa_message_id
  ) VALUES (
    'bbbb2222-0000-0000-0000-000000000002','33330000-0000-0000-0000-000000000003',
    'c3333333-3333-3333-3333-333333333333','e5555555-5555-5555-5555-555555555555',
    'inbound','received','wamid.dup-test-001'
  )$$,
  '23505',
  NULL,
  'Test 10: Duplicate wa_message_id on same connection is rejected (idempotency)'
);

-- TEST 11: Tenant A owner can see own message
SELECT set_config('request.jwt.claims',
  '{"sub":"a1111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT COUNT(*)::int FROM public.messages WHERE id = 'bbbb2222-0000-0000-0000-000000000001'),
  1,
  'Test 11: Tenant A owner can see own inbound message'
);

-- TEST 12: Tenant B owner cannot see Tenant A's message
SELECT set_config('request.jwt.claims',
  '{"sub":"b2222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;

SELECT is(
  (SELECT COUNT(*)::int FROM public.messages
   WHERE id = 'bbbb2222-0000-0000-0000-000000000001'),
  0,
  'Test 12: Tenant B owner cannot see Tenant A inbound message'
);

-- TEST 13: Tenant B owner cannot insert a whatsapp_connection for Tenant A
SELECT throws_ok(
  $$INSERT INTO public.whatsapp_connections
   (organization_id, phone_number_id, waba_id, display_phone_number)
   VALUES ('c3333333-3333-3333-3333-333333333333','pn-hostile','waba-hostile','+10000000099')$$,
  '42501',
  NULL,
  'Test 13: Tenant B owner cannot insert whatsapp_connection into Tenant A org'
);

RESET ROLE;

-- TEST 14: RLS is enabled on every new Phase 3A table
SELECT is(
  (SELECT COUNT(*)::int FROM pg_tables
   WHERE schemaname = 'public'
     AND tablename IN (
       'business_profiles','whatsapp_connections','webhook_events',
       'conversations','messages'
     )
     AND rowsecurity = true),
  5,
  'Test 14: RLS is enabled on all five Phase 3A tables'
);

SELECT * FROM finish();
ROLLBACK;
