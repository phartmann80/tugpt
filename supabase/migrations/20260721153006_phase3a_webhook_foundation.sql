-- Phase 3A: Secure asynchronous inbound-message foundation for WhatsApp.
-- Migration: 20260721153006_phase3a_webhook_foundation.sql
--
-- Scope: additive only. Does not alter any Phase 2 table, trigger, function,
-- or RLS policy. Introduces:
--   1. business_profiles
--   2. whatsapp_connections   (credential REFERENCES only -- never raw tokens)
--   3. webhook_events         (signature-verified receipt + replay-protection ledger)
--   4. conversations
--   5. messages               (idempotent on (whatsapp_connection_id, wa_message_id))
--   6. failed_jobs            (dead-letter record for the PgMq-backed worker)
--   7. pgmq extension + a specifically named inbound WhatsApp queue
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

-- Signature-verified webhook receipt ledger. Replay protection and audit
-- trail, independent of whether an event produced a message.
--
-- Stores the NORMALIZED logical event only -- never the raw webhook
-- envelope JSON (Phase 3A requirement). contact_wa_id / message_type /
-- body_text are the minimal normalized fields the worker needs to persist
-- a conversation/message deterministically; they are extracted from the
-- envelope at the route boundary and the envelope itself is discarded
-- immediately after normalization, not retained anywhere.
CREATE TABLE public.webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  whatsapp_connection_id UUID REFERENCES public.whatsapp_connections(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'whatsapp',
  provider_event_id TEXT NOT NULL,
  signature_verified BOOLEAN NOT NULL,
  status webhook_event_status NOT NULL DEFAULT 'received',
  contact_wa_id TEXT,
  message_type TEXT,
  body_text TEXT,
  wa_timestamp TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  CONSTRAINT unique_provider_event UNIQUE (provider, provider_event_id)
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
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  queue_name TEXT NOT NULL,
  pgmq_msg_id BIGINT,
  payload JSONB NOT NULL,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

CREATE INDEX idx_conversations_org_id ON public.conversations(organization_id);
CREATE INDEX idx_conversations_connection_id ON public.conversations(whatsapp_connection_id);

CREATE INDEX idx_messages_org_id ON public.messages(organization_id);
CREATE INDEX idx_messages_conversation_id ON public.messages(conversation_id);
CREATE INDEX idx_messages_connection_wa_message ON public.messages(whatsapp_connection_id, wa_message_id);

CREATE INDEX idx_failed_jobs_org_id ON public.failed_jobs(organization_id);
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
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.failed_jobs ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.business_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_connections FORCE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_events FORCE ROW LEVEL SECURITY;
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

-- --- WEBHOOK_EVENTS POLICIES ---
-- No client-facing INSERT policy: rows are written exclusively by the
-- webhook route using the service-role key (bypasses RLS by design, same
-- pattern as every other privileged write in this schema). Members may only
-- read events for their own organization.
CREATE POLICY "Members can view their organization's webhook events"
  ON public.webhook_events FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND organization_id IS NOT NULL
    AND private.is_org_member(organization_id, auth.uid())
  );

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

-- --- FAILED_JOBS POLICIES ---
CREATE POLICY "Owners and Admins can view their organization's failed jobs"
  ON public.failed_jobs FOR SELECT
  USING (
    auth.role() = 'authenticated'
    AND organization_id IS NOT NULL
    AND private.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin']::organization_role[])
  );

-- -----------------------------------------------------------------------------
-- 7. PGMQ QUEUE PROVISIONING
-- -----------------------------------------------------------------------------

-- Specifically named inbound WhatsApp queue. Payloads must contain only IDs
-- and correlation metadata (webhook_event_id, organization_id, request_id)
-- -- enforced in application code (apps/web webhook route and apps/worker),
-- not by the queue itself, since pgmq stores an opaque jsonb payload.
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
