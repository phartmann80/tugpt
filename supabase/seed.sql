-- Seed Data for TuGPT.ai Local Development
-- File: supabase/seed.sql

-- Insert default system feature flags
-- global_whatsapp_integration is disabled by default (Phase 3A): the
-- webhook foundation is built but must not be reachable until explicitly
-- enabled per-org.
INSERT INTO public.feature_flags (id, organization_id, key, is_enabled, rules)
VALUES
  ('00000000-0000-0000-0000-000000000001', NULL, 'global_whatsapp_integration', false, '{"description": "Global WhatsApp service availability"}'::jsonb),
  ('00000000-0000-0000-0000-000000000002', NULL, 'global_voice_receptionist', true, '{"description": "Global AI Voice Receptionist availability"}'::jsonb),
  ('00000000-0000-0000-0000-000000000003', NULL, 'global_langdock_orchestrator', true, '{"description": "Global Langdock AI Model Provider"}'::jsonb),
  ('00000000-0000-0000-0000-000000000004', NULL, 'global_mastra_orchestrator', true, '{"description": "Global Mastra AI Agent Orchestrator"}'::jsonb)
ON CONFLICT (organization_id, key) DO NOTHING;
