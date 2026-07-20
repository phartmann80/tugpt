-- Initial Schema & Hardened Multi-Tenant RLS Security for TuGPT.ai
-- Migration: 20260716000001_initial_schema.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Private, non-API-exposed schema for internal security helpers
CREATE SCHEMA IF NOT EXISTS private;

REVOKE ALL ON SCHEMA private FROM PUBLIC;
-- Only authenticated, postgres, and service_role need USAGE to execute RLS functions.
-- anon is completely excluded for defense-in-depth.
GRANT USAGE ON SCHEMA private TO postgres, service_role, authenticated;

-- -----------------------------------------------------------------------------
-- 1. ENUM TYPES
-- -----------------------------------------------------------------------------

CREATE TYPE organization_role AS ENUM (
  'owner',
  'admin',
  'manager',
  'agent',
  'viewer'
);

CREATE TYPE invitation_status AS ENUM (
  'pending',
  'accepted',
  'declined',
  'expired'
);

-- -----------------------------------------------------------------------------
-- 2. CORE TABLES
-- -----------------------------------------------------------------------------

-- User Profiles (Extends auth.users)
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT,
  avatar_url TEXT,
  preferred_locale TEXT NOT NULL DEFAULT 'es',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

-- Multi-Tenant Organizations
CREATE TABLE public.organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  logo_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

-- Organization Memberships & Role Assignments
CREATE TABLE public.organization_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role organization_role NOT NULL DEFAULT 'viewer',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT unique_organization_user UNIQUE (organization_id, user_id)
);

-- Organization Invitations (Stores SHA-256 token hash)
CREATE TABLE public.organization_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role organization_role NOT NULL DEFAULT 'agent',
  token_hash TEXT NOT NULL UNIQUE,
  status invitation_status NOT NULL DEFAULT 'pending',
  invited_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Audit Logs (Append-only)
CREATE TABLE public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Feature Flags
CREATE TABLE public.feature_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT false,
  rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT unique_org_flag_key UNIQUE (organization_id, key)
);

-- -----------------------------------------------------------------------------
-- 3. INDEXES
-- -----------------------------------------------------------------------------

CREATE INDEX idx_profiles_email ON public.profiles(email);
CREATE INDEX idx_organizations_slug ON public.organizations(slug);
CREATE INDEX idx_organizations_deleted_at ON public.organizations(deleted_at);

CREATE INDEX idx_org_members_user_id ON public.organization_members(user_id);
CREATE INDEX idx_org_members_org_id ON public.organization_members(organization_id);
CREATE INDEX idx_org_members_org_user ON public.organization_members(organization_id, user_id);

CREATE INDEX idx_org_invitations_org_id ON public.organization_invitations(organization_id);
CREATE INDEX idx_org_invitations_email ON public.organization_invitations(email);
CREATE INDEX idx_org_invitations_token_hash ON public.organization_invitations(token_hash);

CREATE INDEX idx_audit_logs_org_id ON public.audit_logs(organization_id);
CREATE INDEX idx_audit_logs_user_id ON public.audit_logs(user_id);
CREATE INDEX idx_audit_logs_action ON public.audit_logs(action);

CREATE INDEX idx_feature_flags_org_key ON public.feature_flags(organization_id, key);

-- -----------------------------------------------------------------------------
-- 4. PRIVATE SECURITY HELPER FUNCTIONS
-- -----------------------------------------------------------------------------

-- Helper 1: Check if user is active member of non-deleted org
CREATE OR REPLACE FUNCTION private.is_org_member(p_org_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF p_org_id IS NULL OR p_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.organization_members om
    JOIN public.organizations o ON om.organization_id = o.id
    WHERE om.organization_id = p_org_id
      AND om.user_id = p_user_id
      AND o.deleted_at IS NULL
  );
END;
$$;

-- Helper 2: Get user's active role in org
CREATE OR REPLACE FUNCTION private.get_user_org_role(p_org_id UUID, p_user_id UUID)
RETURNS organization_role
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_role organization_role;
BEGIN
  IF p_org_id IS NULL OR p_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT om.role INTO v_role
  FROM public.organization_members om
  JOIN public.organizations o ON om.organization_id = o.id
  WHERE om.organization_id = p_org_id
    AND om.user_id = p_user_id
    AND o.deleted_at IS NULL;

  RETURN v_role;
END;
$$;

-- Helper 3: Check if user holds any of the required roles in org
CREATE OR REPLACE FUNCTION private.has_org_role(p_org_id UUID, p_user_id UUID, p_roles organization_role[])
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_role organization_role;
BEGIN
  v_role := private.get_user_org_role(p_org_id, p_user_id);
  IF v_role IS NULL THEN
    RETURN FALSE;
  END IF;
  RETURN v_role = ANY(p_roles);
END;
$$;

-- Helper 4: Atomic Organization Creation with Owner Assignment
CREATE OR REPLACE FUNCTION private.create_organization_with_owner(
  p_name TEXT,
  p_slug TEXT,
  p_owner_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_org_id UUID;
  v_normalized_slug TEXT;
BEGIN
  IF (auth.uid() IS NOT NULL AND auth.uid() <> p_owner_id) OR (auth.role() = 'authenticated' AND auth.uid() IS DISTINCT FROM p_owner_id) THEN
    RAISE EXCEPTION 'Unauthorized: p_owner_id must match authenticated user';
  END IF;

  v_normalized_slug := LOWER(TRIM(p_slug));

  IF v_normalized_slug = '' OR p_name IS NULL OR TRIM(p_name) = '' THEN
    RAISE EXCEPTION 'Invalid organization parameters';
  END IF;

  -- Create Organization
  INSERT INTO public.organizations (name, slug)
  VALUES (TRIM(p_name), v_normalized_slug)
  RETURNING id INTO v_org_id;

  -- Assign Creator as Owner
  INSERT INTO public.organization_members (organization_id, user_id, role)
  VALUES (v_org_id, p_owner_id, 'owner');

  -- Log Creation Audit
  INSERT INTO public.audit_logs (organization_id, user_id, action, resource, details)
  VALUES (v_org_id, p_owner_id, 'organization.create', 'organization', jsonb_build_object('name', p_name, 'slug', v_normalized_slug));

  RETURN v_org_id;
END;
$$;

-- Helper 5: Atomic Invitation Acceptance
CREATE OR REPLACE FUNCTION private.accept_invitation(
  p_token_hash TEXT,
  p_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_invitation RECORD;
  v_user_email TEXT;
BEGIN
  IF (auth.uid() IS NOT NULL AND auth.uid() <> p_user_id) OR (auth.role() = 'authenticated' AND auth.uid() IS DISTINCT FROM p_user_id) THEN
    RAISE EXCEPTION 'Unauthorized: p_user_id must match authenticated user';
  END IF;

  -- Get user email
  SELECT email INTO v_user_email FROM public.profiles WHERE id = p_user_id;
  IF v_user_email IS NULL THEN
    RAISE EXCEPTION 'User profile not found';
  END IF;

  -- Lock invitation record
  SELECT * INTO v_invitation
  FROM public.organization_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid or expired invitation token';
  END IF;

  IF v_invitation.status != 'pending' THEN
    RAISE EXCEPTION 'Invitation is no longer pending';
  END IF;

  IF v_invitation.expires_at < NOW() THEN
    UPDATE public.organization_invitations SET status = 'expired' WHERE id = v_invitation.id;
    RAISE EXCEPTION 'Invitation token has expired';
  END IF;

  IF LOWER(v_invitation.email) != LOWER(v_user_email) THEN
    RAISE EXCEPTION 'Invitation email identity mismatch';
  END IF;

  -- Add member
  INSERT INTO public.organization_members (organization_id, user_id, role)
  VALUES (v_invitation.organization_id, p_user_id, v_invitation.role)
  ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role;

  -- Mark invitation accepted
  UPDATE public.organization_invitations
  SET status = 'accepted', updated_at = NOW()
  WHERE id = v_invitation.id;

  -- Audit log
  INSERT INTO public.audit_logs (organization_id, user_id, action, resource, details)
  VALUES (v_invitation.organization_id, p_user_id, 'invitation.accept', 'invitation', jsonb_build_object('email', v_user_email, 'role', v_invitation.role));

  RETURN TRUE;
END;
$$;

-- Helper 6: Prevent Audit Log Modification or Deletion
CREATE OR REPLACE FUNCTION private.prevent_audit_log_modification()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'Audit logs are immutable and cannot be modified or deleted';
END;
$$;

CREATE OR REPLACE FUNCTION private.prevent_last_owner_removal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_owner_count INTEGER;
BEGIN
  -- If the organization itself is being deleted (hard delete cascade), bypass check
  IF current_query() ~* 'delete\s+from\s+(\w+\.)?organizations' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    ELSE
      RETURN NEW;
    END IF;
  END IF;

  IF (TG_OP = 'DELETE' AND OLD.role = 'owner') OR 
     (TG_OP = 'UPDATE' AND OLD.role = 'owner' AND NEW.role <> 'owner') THEN
    
    SELECT COUNT(*) INTO v_owner_count
    FROM public.organization_members
    WHERE organization_id = OLD.organization_id
      AND role = 'owner'
      AND user_id <> OLD.user_id;

    IF v_owner_count = 0 THEN
      RAISE EXCEPTION 'Action blocked: An organization must have at least one active owner';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$;

-- Revoke HTTP/public access to private functions
-- (private schema is not in api.schemas so PostgREST never exposes these)
REVOKE ALL ON FUNCTION private.create_organization_with_owner FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.accept_invitation FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.prevent_audit_log_modification FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.prevent_last_owner_removal FROM PUBLIC, anon, authenticated;

-- Grant EXECUTE on RLS helper functions to authorized querying roles.
-- These functions are invoked inside RLS policies, which run with the calling
-- role's privileges. Without EXECUTE, any SELECT that triggers a policy
-- calling these functions will error.
-- HTTP exposure is blocked at the schema level (private not in api.schemas).
GRANT EXECUTE ON FUNCTION private.is_org_member TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.get_user_org_role TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.has_org_role TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.create_organization_with_owner TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.accept_invitation TO authenticated, service_role;

-- Public Schema Security Definer Wrappers for PostgREST Access
CREATE OR REPLACE FUNCTION public.create_organization_with_owner(
  p_name TEXT,
  p_slug TEXT,
  p_owner_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  RETURN private.create_organization_with_owner(p_name, p_slug, p_owner_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_invitation(
  p_token_hash TEXT,
  p_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  RETURN private.accept_invitation(p_token_hash, p_user_id);
END;
$$;

REVOKE ALL ON FUNCTION public.create_organization_with_owner FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.accept_invitation FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.create_organization_with_owner TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.accept_invitation TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. TRIGGER & AUTOMATIC PROFILE CREATION
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_organization_soft_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.organizations
  SET deleted_at = NOW()
  WHERE id = OLD.id;
  RETURN NULL; -- Cancel the hard delete, turning it into a soft delete
END;
$$;

REVOKE ALL ON FUNCTION public.handle_organization_soft_delete FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trigger_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER trigger_organizations_updated_at BEFORE UPDATE ON public.organizations FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER trigger_organization_members_updated_at BEFORE UPDATE ON public.organization_members FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER trigger_organization_invitations_updated_at BEFORE UPDATE ON public.organization_invitations FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER trigger_feature_flags_updated_at BEFORE UPDATE ON public.feature_flags FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
CREATE TRIGGER trigger_prevent_audit_log_modification BEFORE UPDATE OR DELETE ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION private.prevent_audit_log_modification();
CREATE TRIGGER trigger_prevent_last_owner_removal BEFORE UPDATE OR DELETE ON public.organization_members FOR EACH ROW EXECUTE FUNCTION private.prevent_last_owner_removal();
CREATE TRIGGER trigger_soft_delete_organizations BEFORE DELETE ON public.organizations FOR EACH ROW EXECUTE FUNCTION public.handle_organization_soft_delete();

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', ''),
    NEW.raw_user_meta_data->>'avatar_url'
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    full_name = COALESCE(EXCLUDED.full_name, public.profiles.full_name),
    avatar_url = COALESCE(EXCLUDED.avatar_url, public.profiles.avatar_url),
    updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- -----------------------------------------------------------------------------
-- 6. ROW LEVEL SECURITY & FORCE RLS
-- -----------------------------------------------------------------------------

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE public.organizations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.organization_members FORCE ROW LEVEL SECURITY;
ALTER TABLE public.organization_invitations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.feature_flags FORCE ROW LEVEL SECURITY;

-- --- PROFILES POLICIES ---
CREATE POLICY "Users can view their own profile or profiles of co-members"
  ON public.profiles FOR SELECT
  USING (
    auth.uid() = id
    OR EXISTS (
      SELECT 1 FROM public.organization_members om1
      JOIN public.organization_members om2 ON om1.organization_id = om2.organization_id
      WHERE om1.user_id = auth.uid()
        AND om2.user_id = public.profiles.id
    )
  );

CREATE POLICY "Users can update their own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- --- ORGANIZATIONS POLICIES ---
CREATE POLICY "Members can view their organization"
  ON public.organizations FOR SELECT
  USING (
    deleted_at IS NULL 
    AND auth.role() = 'authenticated' 
    AND private.is_org_member(id, auth.uid())
  );

CREATE POLICY "Owners and Admins can update organization details"
  ON public.organizations FOR UPDATE
  USING (
    deleted_at IS NULL 
    AND auth.role() = 'authenticated' 
    AND private.has_org_role(id, auth.uid(), ARRAY['owner', 'admin']::organization_role[])
  )
  WITH CHECK (
    deleted_at IS NULL 
    AND auth.role() = 'authenticated' 
    AND private.has_org_role(id, auth.uid(), ARRAY['owner', 'admin']::organization_role[])
  );

CREATE POLICY "Authenticated users can create organizations"
  ON public.organizations FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Owners can soft delete organization"
  ON public.organizations FOR DELETE
  USING (
    auth.role() = 'authenticated' 
    AND private.has_org_role(id, auth.uid(), ARRAY['owner']::organization_role[])
  );

-- --- ORGANIZATION MEMBERS POLICIES ---
CREATE POLICY "Members can view organization member lists"
  ON public.organization_members FOR SELECT
  USING (
    auth.role() = 'authenticated' 
    AND private.is_org_member(organization_id, auth.uid())
  );

CREATE POLICY "Owners and Admins can insert members"
  ON public.organization_members FOR INSERT
  WITH CHECK (
    auth.role() = 'authenticated' 
    AND private.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin']::organization_role[])
  );

CREATE POLICY "Owners and Admins can update member roles"
  ON public.organization_members FOR UPDATE
  USING (
    auth.role() = 'authenticated' 
    AND private.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin']::organization_role[])
  )
  WITH CHECK (
    auth.role() = 'authenticated' 
    AND private.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin']::organization_role[])
  );

CREATE POLICY "Owners and Admins can remove members"
  ON public.organization_members FOR DELETE
  USING (
    auth.role() = 'authenticated' 
    AND (
      private.has_org_role(organization_id, auth.uid(), ARRAY['owner']::organization_role[])
      OR (
        private.has_org_role(organization_id, auth.uid(), ARRAY['admin']::organization_role[])
        AND role != 'owner'
      )
      OR auth.uid() = user_id
    )
  );

-- --- ORGANIZATION INVITATIONS POLICIES ---
CREATE POLICY "Members with management role can view invitations"
  ON public.organization_invitations FOR SELECT
  USING (
    auth.role() = 'authenticated' 
    AND private.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin', 'manager']::organization_role[])
  );

CREATE POLICY "Owners and Admins can create invitations"
  ON public.organization_invitations FOR INSERT
  WITH CHECK (
    auth.role() = 'authenticated' 
    AND private.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin']::organization_role[])
    AND invited_by = auth.uid()
  );

CREATE POLICY "Owners and Admins can update invitations"
  ON public.organization_invitations FOR UPDATE
  USING (
    auth.role() = 'authenticated' 
    AND private.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin']::organization_role[])
  );

-- --- AUDIT LOGS POLICIES (Append-Only) ---
CREATE POLICY "Managers, Admins, and Owners can view audit logs"
  ON public.audit_logs FOR SELECT
  USING (
    auth.role() = 'authenticated' 
    AND private.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin', 'manager']::organization_role[])
  );

CREATE POLICY "Members can insert audit logs"
  ON public.audit_logs FOR INSERT
  WITH CHECK (
    auth.role() = 'authenticated' 
    AND private.is_org_member(organization_id, auth.uid())
  );

-- --- FEATURE FLAGS POLICIES ---
CREATE POLICY "Members can view feature flags for their organization"
  ON public.feature_flags FOR SELECT
  USING (
    organization_id IS NULL 
    OR (auth.role() = 'authenticated' AND private.is_org_member(organization_id, auth.uid()))
  );

CREATE POLICY "Owners and Admins can manage feature flags"
  ON public.feature_flags FOR ALL
  USING (
    organization_id IS NOT NULL 
    AND auth.role() = 'authenticated' 
    AND private.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin']::organization_role[])
  )
  WITH CHECK (
    organization_id IS NOT NULL 
    AND auth.role() = 'authenticated' 
    AND private.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin']::organization_role[])
  );

-- -----------------------------------------------------------------------------
-- 7. TABLE GRANTS
-- Object-level permissions must exist for RLS policies to be evaluated.
-- Without these, PostgreSQL denies access before RLS is checked.
-- -----------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organizations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organization_members TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.organization_invitations TO authenticated;
GRANT SELECT, INSERT ON public.audit_logs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.feature_flags TO authenticated;

-- anon role: grant SELECT so RLS policies can evaluate and return 0 rows.
-- Hard REVOKE ALL would bypass RLS entirely, causing permission errors instead
-- of the correct empty-result behaviour that Supabase RLS is designed to produce.
GRANT SELECT ON public.profiles TO anon;
GRANT SELECT ON public.organizations TO anon;
GRANT SELECT ON public.organization_members TO anon;
GRANT SELECT ON public.organization_invitations TO anon;
GRANT SELECT ON public.audit_logs TO anon;
GRANT SELECT ON public.feature_flags TO anon;


