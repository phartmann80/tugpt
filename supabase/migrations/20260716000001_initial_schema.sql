-- Initial Schema & Multi-Tenant RLS Policy for TuGPT.ai
-- Migration: 20260716000001_initial_schema.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

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

-- Organization Invitations
CREATE TABLE public.organization_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role organization_role NOT NULL DEFAULT 'agent',
  token TEXT NOT NULL UNIQUE,
  status invitation_status NOT NULL DEFAULT 'pending',
  invited_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Audit Logs
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
-- 3. INDEXES FOR PERFORMANCE AND AUDIT SCALABILITY
-- -----------------------------------------------------------------------------

CREATE INDEX idx_profiles_email ON public.profiles(email);
CREATE INDEX idx_organizations_slug ON public.organizations(slug);
CREATE INDEX idx_organizations_deleted_at ON public.organizations(deleted_at);

CREATE INDEX idx_org_members_user_id ON public.organization_members(user_id);
CREATE INDEX idx_org_members_org_id ON public.organization_members(organization_id);
CREATE INDEX idx_org_members_org_user ON public.organization_members(organization_id, user_id);

CREATE INDEX idx_org_invitations_org_id ON public.organization_invitations(organization_id);
CREATE INDEX idx_org_invitations_email ON public.organization_invitations(email);
CREATE INDEX idx_org_invitations_token ON public.organization_invitations(token);

CREATE INDEX idx_audit_logs_org_id ON public.audit_logs(organization_id);
CREATE INDEX idx_audit_logs_user_id ON public.audit_logs(user_id);
CREATE INDEX idx_audit_logs_action ON public.audit_logs(action);

CREATE INDEX idx_feature_flags_org_key ON public.feature_flags(organization_id, key);

-- -----------------------------------------------------------------------------
-- 4. TRIGGERS & AUTOMATIC FUNCTIONS
-- -----------------------------------------------------------------------------

-- Automatic updated_at Trigger Function
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trigger_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER trigger_organizations_updated_at
  BEFORE UPDATE ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER trigger_organization_members_updated_at
  BEFORE UPDATE ON public.organization_members
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER trigger_organization_invitations_updated_at
  BEFORE UPDATE ON public.organization_invitations
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

CREATE TRIGGER trigger_feature_flags_updated_at
  BEFORE UPDATE ON public.feature_flags
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- Automatic Profile Creation Trigger on Auth Signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- -----------------------------------------------------------------------------
-- 5. SQL SECURITY & HELPER FUNCTIONS
-- -----------------------------------------------------------------------------

-- Helper: Check if user is active member of org
CREATE OR REPLACE FUNCTION public.is_org_member(p_org_id UUID, p_user_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.organization_members om
    JOIN public.organizations o ON om.organization_id = o.id
    WHERE om.organization_id = p_org_id
      AND om.user_id = p_user_id
      AND o.deleted_at IS NULL
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- Helper: Get user's role in org
CREATE OR REPLACE FUNCTION public.get_user_org_role(p_org_id UUID, p_user_id UUID)
RETURNS organization_role AS $$
DECLARE
  v_role organization_role;
BEGIN
  SELECT om.role INTO v_role
  FROM public.organization_members om
  JOIN public.organizations o ON om.organization_id = o.id
  WHERE om.organization_id = p_org_id
    AND om.user_id = p_user_id
    AND o.deleted_at IS NULL;
  
  RETURN v_role;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- Helper: Check if user has required role in org
CREATE OR REPLACE FUNCTION public.has_org_role(p_org_id UUID, p_user_id UUID, p_roles organization_role[])
RETURNS BOOLEAN AS $$
DECLARE
  v_role organization_role;
BEGIN
  v_role := public.get_user_org_role(p_org_id, p_user_id);
  IF v_role IS NULL THEN
    RETURN FALSE;
  END IF;
  RETURN v_role = ANY(p_roles);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- -----------------------------------------------------------------------------
-- 6. ROW LEVEL SECURITY (RLS) POLICIES
-- -----------------------------------------------------------------------------

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;

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
    deleted_at IS NULL AND public.is_org_member(id, auth.uid())
  );

CREATE POLICY "Owners and Admins can update organization details"
  ON public.organizations FOR UPDATE
  USING (
    deleted_at IS NULL AND public.has_org_role(id, auth.uid(), ARRAY['owner', 'admin']::organization_role[])
  )
  WITH CHECK (
    deleted_at IS NULL AND public.has_org_role(id, auth.uid(), ARRAY['owner', 'admin']::organization_role[])
  );

CREATE POLICY "Authenticated users can create organizations"
  ON public.organizations FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Owners can soft delete organization"
  ON public.organizations FOR DELETE
  USING (
    public.has_org_role(id, auth.uid(), ARRAY['owner']::organization_role[])
  );

-- --- ORGANIZATION MEMBERS POLICIES ---
CREATE POLICY "Members can view organization member lists"
  ON public.organization_members FOR SELECT
  USING (
    public.is_org_member(organization_id, auth.uid())
  );

CREATE POLICY "Owners and Admins can manage members"
  ON public.organization_members FOR INSERT
  WITH CHECK (
    public.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin']::organization_role[])
    OR auth.uid() = user_id -- Self-membership upon initial org creation
  );

CREATE POLICY "Owners and Admins can update member roles"
  ON public.organization_members FOR UPDATE
  USING (
    public.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin']::organization_role[])
  )
  WITH CHECK (
    public.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin']::organization_role[])
  );

CREATE POLICY "Owners and Admins can remove members"
  ON public.organization_members FOR DELETE
  USING (
    public.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin']::organization_role[])
    OR auth.uid() = user_id -- Allow self-leave
  );

-- --- ORGANIZATION INVITATIONS POLICIES ---
CREATE POLICY "Members with management role can view invitations"
  ON public.organization_invitations FOR SELECT
  USING (
    public.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin', 'manager']::organization_role[])
    OR email = (SELECT email FROM public.profiles WHERE id = auth.uid())
  );

CREATE POLICY "Owners and Admins can create invitations"
  ON public.organization_invitations FOR INSERT
  WITH CHECK (
    public.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin']::organization_role[])
    AND invited_by = auth.uid()
  );

CREATE POLICY "Owners and Admins can delete or update invitations"
  ON public.organization_invitations FOR UPDATE
  USING (
    public.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin']::organization_role[])
  );

-- --- AUDIT LOGS POLICIES ---
CREATE POLICY "Managers, Admins, and Owners can view audit logs"
  ON public.audit_logs FOR SELECT
  USING (
    public.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin', 'manager']::organization_role[])
  );

CREATE POLICY "Members can insert audit logs for their organization"
  ON public.audit_logs FOR INSERT
  WITH CHECK (
    public.is_org_member(organization_id, auth.uid())
  );

-- --- FEATURE FLAGS POLICIES ---
CREATE POLICY "Members can view feature flags for their organization"
  ON public.feature_flags FOR SELECT
  USING (
    organization_id IS NULL OR public.is_org_member(organization_id, auth.uid())
  );

CREATE POLICY "Owners and Admins can manage feature flags"
  ON public.feature_flags FOR ALL
  USING (
    organization_id IS NULL OR public.has_org_role(organization_id, auth.uid(), ARRAY['owner', 'admin']::organization_role[])
  );
