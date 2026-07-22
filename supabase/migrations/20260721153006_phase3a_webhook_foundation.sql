-- Phase 3A: Secure asynchronous inbound-message foundation for WhatsApp.
-- Migration: 20260721153006_phase3a_webhook_foundation.sql
--
-- Scope: additive only. Does not alter any Phase 2 table, trigger, function,
-- or RLS policy. Introduces:
--   1. business_profiles
--   2. whatsapp_connections   (credential REFERENCES only -- never raw tokens)
--   3. webhook_events         (metadata-only receipt + replay-protection ledger)
--   4. inbound_message_staging (server-only content awaiting the worker)
--   5. conversations
--   6. messages               (idempotent on (whatsapp_connection_id, wa_message_id))
--   7. failed_jobs            (narrow dead-letter record; no copied payload)
--   8. pgmq extension + a specifically named inbound WhatsApp queue
--
-- No AI orchestration, no outbound sending, no live provider calls are
-- introduced by this migration. Queue payloads carry IDs and correlation
-- metadata only -- see apps/worker and the webhook route for enforcement.

-- -----------------------------------------------------------------------------
-- 1. EXTENSIONS
-- -----------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS "pgmq";

-- -----------------------------------------------------------------------------
-- 2. ENUM TYPES
-- -----------------------------------------------------------------------------

CREATE TYPE whatsapp_connection_status AS ENUM (
  'pending',
  'connected',
  'error',
  'disconnected'
);

CREATE TYPE webhook_event_status AS ENUM (
  'received',
  'processed',
  'failed'
);

CREATE TYPE conversation_status AS ENUM (
  'open',
  'needs_human',
  'closed'
);

CREATE TYPE message_direction AS ENUM (
  'inbound',
  'outbound'
);

CREATE TYPE message_status AS ENUM (
  'received',
  'draft',
  'sent',
  'failed'
);

-- -----------------------------------------------------------------------------
-- 3. CORE TABLES
-- -----------------------------------------------------------------------------

-- Business profile & operating settings (1:1 with organizations).
CREATE TABLE public.business_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_name TEXT NOT NULL,
  greeting_message TEXT,
  operating_hours JSONB NOT NULL DEFAULT '{}'::jsonb,
  escalation_email TEXT,
  escalation_phone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- WhatsApp connection boundary. Stores connection metadata only.
-- access_token_ref / app_secret_ref are opaque references to a SecretStore
-- entry (introduced in a later Phase 3 slice) -- this table never stores a
-- raw token or secret value.
CREATE TABLE public.whatsapp_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  phone_number_id TEXT NOT NULL,
  waba_id TEXT,
  display_phone_number TEXT,
  access_token_ref TEXT,
  app_secret_ref TEXT,
  verify_token_ref TEXT,
  status whatsapp_connection_status NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT unique_phone_number_id UNIQUE (phone_number_id)
);

-- Signature-verified, metadata-only webhook receipt ledger. Replay
-- protection and audit trail are kept here without customer message content
-- or contact identifiers. The normalized content needed by the worker lives
-- temporarily in inbound_message_staging, which has no client policies.
CREATE TABLE public.webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  whatsapp_connection_id UUID NOT NULL REFERENCES public.whatsapp_connections(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'whatsapp',
  provider_event_id TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  signature_verified BOOLEAN NOT NULL CHECK (signature_verified),
  status webhook_event_status NOT NULL DEFAULT 'received',
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  CONSTRAINT unique_provider_event UNIQUE (provider, provider_event_id)
);

-- Normalized inbound content held only until the atomic worker RPC commits
-- it into conversations/messages. This table is server-only: FORCE RLS,
-- no policies, and explicit client-role revokes below.
CREATE TABLE public.inbound_message_staging (
  webhook_event_id UUID PRIMARY KEY REFERENCES public.webhook_events(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  whatsapp_connection_id UUID NOT NULL REFERENCES public.whatsapp_connections(id) ON DELETE CASCADE,
  contact_wa_id TEXT NOT NULL,
  message_type TEXT NOT NULL,
  body_text TEXT,
  wa_timestamp TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Conversations (one per end-customer WhatsApp contact per connection).
CREATE TABLE public.conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  whatsapp_connection_id UUID NOT NULL REFERENCES public.whatsapp_connections(id) ON DELETE CASCADE,
  contact_wa_id TEXT NOT NULL,
  status conversation_status NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT unique_connection_contact UNIQUE (whatsapp_connection_id, contact_wa_id)
);

-- Messages. Idempotent on (whatsapp_connection_id, wa_message_id) so a
-- redelivered webhook or a redelivered queue message can never create a
-- duplicate row.
CREATE TABLE public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  whatsapp_connection_id UUID NOT NULL REFERENCES public.whatsapp_connections(id) ON DELETE CASCADE,
  webhook_event_id UUID REFERENCES public.webhook_events(id) ON DELETE SET NULL,
  wa_message_id TEXT,
  direction message_direction NOT NULL,
  status message_status NOT NULL DEFAULT 'received',
  body TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT unique_connection_wa_message UNIQUE (whatsapp_connection_id, wa_message_id)
);

-- Dead-letter record for jobs that exhausted retries on the PgMq-backed
-- queue. Distinct from webhook_events: this tracks queue-processing
-- failures, not ingestion failures.
CREATE TABLE public.failed_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_event_id UUID NOT NULL REFERENCES public.webhook_events(id) ON DELETE CASCADE,
  queue_name TEXT NOT NULL,
  pgmq_msg_id BIGINT NOT NULL,
  error TEXT NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT unique_failed_queue_message UNIQUE (queue_name, pgmq_msg_id)
);

-- -----------------------------------------------------------------------------
-- 4. INDEXES
-- -----------------------------------------------------------------------------

CREATE INDEX idx_business_profiles_org_id ON public.business_profiles(organization_id);

CREATE INDEX idx_whatsapp_connections_org_id ON public.whatsapp_connections(organization_id);
CREATE INDEX idx_whatsapp_connections_phone_number_id ON public.whatsapp_connections(phone_number_id);

CREATE INDEX idx_webhook_events_org_id ON public.webhook_events(organization_id);
CREATE INDEX idx_webhook_events_connection_id ON public.webhook_events(whatsapp_connection_id);
CREATE INDEX idx_webhook_events_provider_event ON public.webhook_events(provider, provider_event_id);

CREATE INDEX idx_inbound_message_staging_org_id ON public.inbound_message_staging(organization_id);
CREATE INDEX idx_inbound_message_staging_connection_id ON public.inbound_message_staging(whatsapp_connection_id);

CREATE INDEX idx_conversations_org_id ON public.conversations(organization_id);
CREATE INDEX idx_conversations_connection_id ON public.conversations(whatsapp_connection_id);

CREATE INDEX idx_messages_org_id ON public.messages(organization_id);
CREATE INDEX idx_messages_conversation_id ON public.messages(conversation_id);
CREATE INDEX idx_messages_connection_wa_message ON public.messages(whatsapp_connection_id, wa_message_id);

CREATE INDEX idx_failed_jobs_webhook_event_id ON public.failed_jobs(webhook_event_id);
CREATE INDEX idx_failed_jobs_queue_name ON public.failed_jobs(queue_name);

-- -----------------------------------------------------------------------------
-- 5. UPDATED_AT TRIGGERS (reuses public.handle_updated_at() from Phase 2)
-- -----------------------------------------------------------------------------

CREATE TRIGGER trigger_business_profiles_updated_at BEFORE UPDATE ON public.business_profiles FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER trigger_whatsapp_connections_updated_at BEFORE UPDATE ON public.whatsapp_connections FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER trigger_conversations_updated_at BEFORE UPDATE ON public.conversations FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER trigger_messages_updated_at BEFORE UPDATE ON public.messages FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- -----------------------------------------------------------------------------
-- 6. ROW LEVEL SECURITY & FORCE RLS
-- -----------------------------------------------------------------------------

ALTER TABLE public.business_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbound_message_staging ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.failed_jobs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.business_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.inbound_message_staging FORCE ROW LEVEL SECURITY;
ALTER TABLE public.conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.messages FORCE ROW LEVEL SECURITY;
ALTER TABLE public.failed_jobs FORCE ROW LEVEL SECURITY;

-- --- BUSINESS_PROFILES POLICIES ---
CREATE POLICY "Members can view their organization's business profile"
  ON public.business_profiles FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND private.is_org_member(organization_id, auth.uid())
  );

CREATE POLICY "Owners and Admins can manage business profile"
  ON public.business_profiles FOR ALL
  USING (
    auth.role() = 'authenticated'
    AND private.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin']::organization_role[])
  )
  WITH CHECK (
    auth.role() = 'authenticated'
    AND private.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin']::organization_role[])
  );

-- --- WHATSAPP_CONNECTIONS POLICIES ---
CREATE POLICY "Members can view their organization's WhatsApp connections"
  ON public.whatsapp_connections FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND private.is_org_member(organization_id, auth.uid())
  );

CREATE POLICY "Owners and Admins can manage WhatsApp connections"
  ON public.whatsapp_connections FOR ALL
  USING (
    auth.role() = 'authenticated'
    AND private.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin']::organization_role[])
  )
  WITH CHECK (
    auth.role() = 'authenticated'
    AND private.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin']::organization_role[])
  );

-- webhook_events and inbound_message_staging intentionally have no policies.
-- They are service-only implementation tables reached through the three
-- narrow RPCs below, never through a browser/client Supabase connection.

-- --- CONVERSATIONS POLICIES ---
CREATE POLICY "Members can view their organization's conversations"
  ON public.conversations FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND private.is_org_member(organization_id, auth.uid())
  );

CREATE POLICY "Managers, Admins, and Owners can update conversations"
  ON public.conversations FOR UPDATE
  USING (
    auth.role() = 'authenticated'
    AND private.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin', 'manager']::organization_role[])
  )
  WITH CHECK (
    auth.role() = 'authenticated'
    AND private.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin', 'manager']::organization_role[])
  );

-- --- MESSAGES POLICIES ---
-- No client-facing INSERT policy: inbound rows are written by the worker
-- using the service-role key. Members may only read messages for their own
-- organization.
CREATE POLICY "Members can view their organization's messages"
  ON public.messages FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND private.is_org_member(organization_id, auth.uid())
  );

-- failed_jobs is also service-only and intentionally has no policy. It stores
-- a receipt reference and bounded diagnostic text, never a copied job payload.

-- -----------------------------------------------------------------------------
-- 7. PGMQ QUEUE PROVISIONING
-- -----------------------------------------------------------------------------

-- Specifically named inbound WhatsApp queue. The atomic ingestion RPC below
-- creates the only allowed Phase 3A payload shape: webhookEventId plus
-- correlation metadata. Tenant IDs and message/customer content are excluded.
SELECT pgmq.create('whatsapp_inbound_v1');

-- -----------------------------------------------------------------------------
-- 8. PGMQ RPC WRAPPERS (service-role only)
-- -----------------------------------------------------------------------------
--
-- pgmq's own functions live in the pgmq schema, which is not exposed over
-- PostgREST. Rather than adding a raw Postgres driver dependency to
-- @tugpt/jobs, PgMqJobQueue calls these thin SECURITY DEFINER wrappers via
-- the existing supabase-js `.rpc()` client (service-role only -- never
-- granted to anon/authenticated, since queue access is a server-side
-- concern, not a client-facing one).

CREATE OR REPLACE FUNCTION private.pgmq_send(
  p_queue_name TEXT,
  p_message JSONB,
  p_delay_seconds INTEGER DEFAULT 0
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pgmq, public, private, pg_temp
AS $$
DECLARE
  v_msg_id BIGINT;
BEGIN
  SELECT * INTO v_msg_id FROM pgmq.send(p_queue_name, p_message, p_delay_seconds);
  RETURN v_msg_id;
END;
$$;

CREATE OR REPLACE FUNCTION private.pgmq_read(
  p_queue_name TEXT,
  p_visibility_timeout_seconds INTEGER,
  p_quantity INTEGER
)
RETURNS TABLE (
  msg_id BIGINT,
  read_ct INTEGER,
  enqueued_at TIMESTAMPTZ,
  vt TIMESTAMPTZ,
  message JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pgmq, public, private, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT r.msg_id, r.read_ct, r.enqueued_at, r.vt, r.message
  FROM pgmq.read(p_queue_name, p_visibility_timeout_seconds, p_quantity) r;
END;
$$;

CREATE OR REPLACE FUNCTION private.pgmq_archive(
  p_queue_name TEXT,
  p_msg_id BIGINT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pgmq, public, private, pg_temp
AS $$
DECLARE
  v_result BOOLEAN;
BEGIN
  SELECT * INTO v_result FROM pgmq.archive(p_queue_name, p_msg_id);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION private.pgmq_delete(
  p_queue_name TEXT,
  p_msg_id BIGINT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pgmq, public, private, pg_temp
AS $$
DECLARE
  v_result BOOLEAN;
BEGIN
  SELECT * INTO v_result FROM pgmq.delete(p_queue_name, p_msg_id);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION private.pgmq_send FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.pgmq_read FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.pgmq_archive FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.pgmq_delete FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION private.pgmq_send TO service_role;
GRANT EXECUTE ON FUNCTION private.pgmq_read TO service_role;
GRANT EXECUTE ON FUNCTION private.pgmq_archive TO service_role;
GRANT EXECUTE ON FUNCTION private.pgmq_delete TO service_role;

-- Public-schema pass-throughs so supabase-js `.rpc('pgmq_send', ...)` can
-- reach the private implementation, mirroring the existing
-- create_organization_with_owner / accept_invitation pattern from Phase 2.

CREATE OR REPLACE FUNCTION public.pgmq_send(
  p_queue_name TEXT,
  p_message JSONB,
  p_delay_seconds INTEGER DEFAULT 0
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  RETURN private.pgmq_send(p_queue_name, p_message, p_delay_seconds);
END;
$$;

CREATE OR REPLACE FUNCTION public.pgmq_read(
  p_queue_name TEXT,
  p_visibility_timeout_seconds INTEGER,
  p_quantity INTEGER
)
RETURNS TABLE (
  msg_id BIGINT,
  read_ct INTEGER,
  enqueued_at TIMESTAMPTZ,
  vt TIMESTAMPTZ,
  message JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  RETURN QUERY SELECT * FROM private.pgmq_read(p_queue_name, p_visibility_timeout_seconds, p_quantity);
END;
$$;

CREATE OR REPLACE FUNCTION public.pgmq_archive(
  p_queue_name TEXT,
  p_msg_id BIGINT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  RETURN private.pgmq_archive(p_queue_name, p_msg_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.pgmq_delete(
  p_queue_name TEXT,
  p_msg_id BIGINT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  RETURN private.pgmq_delete(p_queue_name, p_msg_id);
END;
$$;

REVOKE ALL ON FUNCTION public.pgmq_send FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pgmq_read FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pgmq_archive FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pgmq_delete FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.pgmq_send TO service_role;
GRANT EXECUTE ON FUNCTION public.pgmq_read TO service_role;
GRANT EXECUTE ON FUNCTION public.pgmq_archive TO service_role;
GRANT EXECUTE ON FUNCTION public.pgmq_delete TO service_role;

-- -----------------------------------------------------------------------------
-- 9. ATOMIC WHATSAPP INGESTION / PROCESSING / DEAD-LETTER OPERATIONS
-- -----------------------------------------------------------------------------

-- Resolves tenancy from the registered phone_number_id, creates the
-- metadata-only receipt, stages normalized content, and enqueues the receipt
-- ID in one PostgreSQL transaction. If pgmq.send fails, neither table insert
-- can commit. Duplicate provider events never enqueue a second job.
CREATE OR REPLACE FUNCTION private.ingest_whatsapp_message_event(
  p_phone_number_id TEXT,
  p_provider_event_id TEXT,
  p_contact_wa_id TEXT,
  p_message_type TEXT,
  p_body_text TEXT DEFAULT NULL,
  p_wa_timestamp TEXT DEFAULT NULL,
  p_request_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pgmq, public, private, pg_temp
AS $$
DECLARE
  v_connection_id UUID;
  v_organization_id UUID;
  v_webhook_event_id UUID;
  v_pgmq_msg_id BIGINT;
  v_queue_payload JSONB;
BEGIN
  IF NULLIF(BTRIM(p_phone_number_id), '') IS NULL
     OR NULLIF(BTRIM(p_provider_event_id), '') IS NULL
     OR NULLIF(BTRIM(p_contact_wa_id), '') IS NULL
     OR NULLIF(BTRIM(p_message_type), '') IS NULL THEN
    RAISE EXCEPTION 'WhatsApp ingestion requires phone, provider event, contact, and message type identifiers'
      USING ERRCODE = '22023';
  END IF;

  SELECT wc.id, wc.organization_id
    INTO v_connection_id, v_organization_id
  FROM public.whatsapp_connections wc
  WHERE wc.phone_number_id = p_phone_number_id
    AND wc.status = 'connected'
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'outcome', 'unknown_connection',
      'webhook_event_id', NULL,
      'pgmq_msg_id', NULL
    );
  END IF;

  INSERT INTO public.webhook_events (
    organization_id,
    whatsapp_connection_id,
    provider,
    provider_event_id,
    event_kind,
    signature_verified,
    status
  ) VALUES (
    v_organization_id,
    v_connection_id,
    'whatsapp',
    p_provider_event_id,
    'message',
    TRUE,
    'received'
  )
  ON CONFLICT (provider, provider_event_id) DO NOTHING
  RETURNING id INTO v_webhook_event_id;

  IF v_webhook_event_id IS NULL THEN
    SELECT we.id INTO v_webhook_event_id
    FROM public.webhook_events we
    WHERE we.provider = 'whatsapp'
      AND we.provider_event_id = p_provider_event_id;

    RETURN jsonb_build_object(
      'outcome', 'duplicate',
      'webhook_event_id', v_webhook_event_id,
      'pgmq_msg_id', NULL
    );
  END IF;

  INSERT INTO public.inbound_message_staging (
    webhook_event_id,
    organization_id,
    whatsapp_connection_id,
    contact_wa_id,
    message_type,
    body_text,
    wa_timestamp
  ) VALUES (
    v_webhook_event_id,
    v_organization_id,
    v_connection_id,
    p_contact_wa_id,
    p_message_type,
    p_body_text,
    p_wa_timestamp
  );

  v_queue_payload := jsonb_strip_nulls(jsonb_build_object(
    'webhookEventId', v_webhook_event_id::TEXT,
    'requestId', NULLIF(p_request_id, ''),
    'timestamp', NOW()
  ));

  SELECT * INTO v_pgmq_msg_id
  FROM pgmq.send('whatsapp_inbound_v1', v_queue_payload, 0);

  RETURN jsonb_build_object(
    'outcome', 'queued',
    'webhook_event_id', v_webhook_event_id,
    'pgmq_msg_id', v_pgmq_msg_id::TEXT
  );
END;
$$;

-- Derives organization and connection identity exclusively from the locked
-- receipt/staging rows. The queue supplies only the receipt ID. Conversation
-- conflict handling deliberately preserves needs_human/closed state.
CREATE OR REPLACE FUNCTION private.process_whatsapp_inbound_receipt(
  p_webhook_event_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_receipt public.webhook_events%ROWTYPE;
  v_staging public.inbound_message_staging%ROWTYPE;
  v_conversation_id UUID;
  v_message_row_count INTEGER;
BEGIN
  SELECT * INTO v_receipt
  FROM public.webhook_events
  WHERE id = p_webhook_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referenced webhook receipt % was not found', p_webhook_event_id
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT v_receipt.signature_verified THEN
    RAISE EXCEPTION 'Refusing to process unverified webhook receipt %', p_webhook_event_id
      USING ERRCODE = '22023';
  END IF;

  IF v_receipt.status = 'processed' THEN
    RETURN jsonb_build_object('outcome', 'already_processed');
  END IF;

  IF v_receipt.status <> 'received' THEN
    RAISE EXCEPTION 'Webhook receipt % is not processable from status %', p_webhook_event_id, v_receipt.status
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_staging
  FROM public.inbound_message_staging
  WHERE webhook_event_id = p_webhook_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inbound staging row for webhook receipt % was not found', p_webhook_event_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_staging.organization_id <> v_receipt.organization_id
     OR v_staging.whatsapp_connection_id <> v_receipt.whatsapp_connection_id THEN
    RAISE EXCEPTION 'Inbound staging tenant identity does not match webhook receipt %', p_webhook_event_id
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.whatsapp_connections wc
  WHERE wc.id = v_receipt.whatsapp_connection_id
    AND wc.organization_id = v_receipt.organization_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Webhook receipt % references an invalid tenant connection', p_webhook_event_id
      USING ERRCODE = '23503';
  END IF;

  INSERT INTO public.conversations (
    organization_id,
    whatsapp_connection_id,
    contact_wa_id
  ) VALUES (
    v_receipt.organization_id,
    v_receipt.whatsapp_connection_id,
    v_staging.contact_wa_id
  )
  ON CONFLICT (whatsapp_connection_id, contact_wa_id) DO NOTHING
  RETURNING id INTO v_conversation_id;

  IF v_conversation_id IS NULL THEN
    SELECT c.id INTO v_conversation_id
    FROM public.conversations c
    WHERE c.organization_id = v_receipt.organization_id
      AND c.whatsapp_connection_id = v_receipt.whatsapp_connection_id
      AND c.contact_wa_id = v_staging.contact_wa_id;
  END IF;

  IF v_conversation_id IS NULL THEN
    RAISE EXCEPTION 'Existing conversation conflicts with authoritative tenant identity for receipt %', p_webhook_event_id
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.messages (
    organization_id,
    conversation_id,
    whatsapp_connection_id,
    webhook_event_id,
    wa_message_id,
    direction,
    status,
    body
  ) VALUES (
    v_receipt.organization_id,
    v_conversation_id,
    v_receipt.whatsapp_connection_id,
    v_receipt.id,
    v_receipt.provider_event_id,
    'inbound',
    'received',
    v_staging.body_text
  )
  ON CONFLICT (whatsapp_connection_id, wa_message_id) DO NOTHING;

  GET DIAGNOSTICS v_message_row_count = ROW_COUNT;

  UPDATE public.webhook_events
  SET status = 'processed',
      processed_at = COALESCE(processed_at, NOW())
  WHERE id = p_webhook_event_id
    AND status = 'received';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Webhook receipt % changed state during processing', p_webhook_event_id
      USING ERRCODE = '40001';
  END IF;

  DELETE FROM public.inbound_message_staging
  WHERE webhook_event_id = p_webhook_event_id;

  RETURN jsonb_build_object(
    'outcome', 'processed',
    'conversation_id', v_conversation_id,
    'message_created', v_message_row_count = 1
  );
END;
$$;

-- Writes the narrow dead-letter record, status-marks an unprocessed receipt,
-- and archives the pgmq row in one transaction. It never copies the queue
-- payload or accepts tenant identity from the worker.
CREATE OR REPLACE FUNCTION private.dead_letter_job(
  p_queue_name TEXT,
  p_pgmq_msg_id BIGINT,
  p_webhook_event_id UUID,
  p_error TEXT,
  p_attempts INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pgmq, public, private, pg_temp
AS $$
DECLARE
  v_archived BOOLEAN;
BEGIN
  IF p_queue_name <> 'whatsapp_inbound_v1' THEN
    RAISE EXCEPTION 'Unsupported dead-letter queue %', p_queue_name
      USING ERRCODE = '22023';
  END IF;

  IF p_attempts <= 0 THEN
    RAISE EXCEPTION 'Dead-letter attempts must be positive'
      USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.webhook_events
  WHERE id = p_webhook_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Referenced webhook receipt % was not found for dead-lettering', p_webhook_event_id
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.failed_jobs (
    webhook_event_id,
    queue_name,
    pgmq_msg_id,
    error,
    attempts
  ) VALUES (
    p_webhook_event_id,
    p_queue_name,
    p_pgmq_msg_id,
    LEFT(COALESCE(NULLIF(p_error, ''), 'Unknown worker error'), 2000),
    p_attempts
  )
  ON CONFLICT (queue_name, pgmq_msg_id) DO UPDATE
  SET error = EXCLUDED.error,
      attempts = GREATEST(public.failed_jobs.attempts, EXCLUDED.attempts);

  UPDATE public.webhook_events
  SET status = 'failed'
  WHERE id = p_webhook_event_id
    AND status = 'received';

  SELECT * INTO v_archived
  FROM pgmq.archive(p_queue_name, p_pgmq_msg_id);

  IF NOT COALESCE(v_archived, FALSE) THEN
    RAISE EXCEPTION 'Could not archive pgmq message % from queue %', p_pgmq_msg_id, p_queue_name
      USING ERRCODE = 'P0001';
  END IF;

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION private.ingest_whatsapp_message_event FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.process_whatsapp_inbound_receipt FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.dead_letter_job FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION private.ingest_whatsapp_message_event TO service_role;
GRANT EXECUTE ON FUNCTION private.process_whatsapp_inbound_receipt TO service_role;
GRANT EXECUTE ON FUNCTION private.dead_letter_job TO service_role;

-- Public-schema RPC wrappers for supabase-js. Each remains service-role only.
CREATE OR REPLACE FUNCTION public.ingest_whatsapp_message_event(
  p_phone_number_id TEXT,
  p_provider_event_id TEXT,
  p_contact_wa_id TEXT,
  p_message_type TEXT,
  p_body_text TEXT DEFAULT NULL,
  p_wa_timestamp TEXT DEFAULT NULL,
  p_request_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  RETURN private.ingest_whatsapp_message_event(
    p_phone_number_id,
    p_provider_event_id,
    p_contact_wa_id,
    p_message_type,
    p_body_text,
    p_wa_timestamp,
    p_request_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.process_whatsapp_inbound_receipt(
  p_webhook_event_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  RETURN private.process_whatsapp_inbound_receipt(p_webhook_event_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.dead_letter_job(
  p_queue_name TEXT,
  p_pgmq_msg_id BIGINT,
  p_webhook_event_id UUID,
  p_error TEXT,
  p_attempts INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  RETURN private.dead_letter_job(
    p_queue_name,
    p_pgmq_msg_id,
    p_webhook_event_id,
    p_error,
    p_attempts
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ingest_whatsapp_message_event FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.process_whatsapp_inbound_receipt FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dead_letter_job FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.ingest_whatsapp_message_event TO service_role;
GRANT EXECUTE ON FUNCTION public.process_whatsapp_inbound_receipt TO service_role;
GRANT EXECUTE ON FUNCTION public.dead_letter_job TO service_role;

-- -----------------------------------------------------------------------------
-- 10. TABLE GRANTS
-- -----------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON public.business_profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_connections TO authenticated;
GRANT SELECT, UPDATE ON public.conversations TO authenticated;
GRANT SELECT ON public.messages TO authenticated;

-- Grant SELECT on client-visible tables so anon queries are filtered to zero
-- rows by RLS instead of revealing table existence through permission errors.
GRANT SELECT ON public.business_profiles TO anon;
GRANT SELECT ON public.whatsapp_connections TO anon;
GRANT SELECT ON public.conversations TO anon;
GRANT SELECT ON public.messages TO anon;

-- Server-only tables are inaccessible to browser roles even before RLS is
-- evaluated. service_role access exists for operations/diagnostics; normal
-- application writes still go through the atomic RPCs above.
REVOKE ALL ON TABLE public.webhook_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.inbound_message_staging FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.failed_jobs FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE public.webhook_events TO service_role;
GRANT ALL ON TABLE public.inbound_message_staging TO service_role;
GRANT ALL ON TABLE public.failed_jobs TO service_role;
