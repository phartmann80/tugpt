export type OrganizationRole = 'owner' | 'admin' | 'manager' | 'agent' | 'viewer';
export type InvitationStatus = 'pending' | 'accepted' | 'declined' | 'expired';

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  preferred_locale: 'es' | 'en';
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface OrganizationMember {
  id: string;
  organization_id: string;
  user_id: string;
  role: OrganizationRole;
  created_at: string;
  updated_at: string;
}

export interface OrganizationInvitation {
  id: string;
  organization_id: string;
  email: string;
  role: OrganizationRole;
  token_hash: string;
  status: InvitationStatus;
  invited_by: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface AuditLog {
  id: string;
  organization_id: string;
  user_id: string | null;
  action: string;
  resource: string;
  details: Record<string, unknown>;
  ip_address: string | null;
  created_at: string;
}

export interface FeatureFlag {
  id: string;
  organization_id: string | null;
  key: string;
  is_enabled: boolean;
  rules: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: Profile;
        Insert: Omit<Profile, 'created_at' | 'updated_at'> & { created_at?: string; updated_at?: string };
        Update: Partial<Profile>;
      };
      organizations: {
        Row: Organization;
        Insert: Omit<Organization, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<Organization>;
      };
      organization_members: {
        Row: OrganizationMember;
        Insert: Omit<OrganizationMember, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<OrganizationMember>;
      };
      organization_invitations: {
        Row: OrganizationInvitation;
        Insert: Omit<OrganizationInvitation, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<OrganizationInvitation>;
      };
      audit_logs: {
        Row: AuditLog;
        Insert: Omit<AuditLog, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<AuditLog>;
      };
      feature_flags: {
        Row: FeatureFlag;
        Insert: Omit<FeatureFlag, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<FeatureFlag>;
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      create_organization_with_owner: {
        Args: {
          p_name: string;
          p_slug: string;
          p_owner_id: string;
        };
        Returns: string;
      };
    };
    Enums: {
      organization_role: OrganizationRole;
      invitation_status: InvitationStatus;
    };
  };
}
