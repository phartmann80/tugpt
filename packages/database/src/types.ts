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

// -- Phase 3A: secure asynchronous inbound-message foundation -------------

export type WhatsAppConnectionStatus = 'pending' | 'connected' | 'error' | 'disconnected';
export type WebhookEventStatus = 'received' | 'processed' | 'failed';
export type ConversationStatus = 'open' | 'needs_human' | 'closed';
export type MessageDirection = 'inbound' | 'outbound';
export type MessageStatus = 'received' | 'draft' | 'sent' | 'failed';
export type WhatsAppIngestOutcome = 'queued' | 'duplicate' | 'unknown_connection';
export type WhatsAppProcessOutcome = 'processed' | 'already_processed';

export interface WhatsAppIngestResult {
  outcome: WhatsAppIngestOutcome;
  webhook_event_id: string | null;
  /** bigint is serialized as text so JavaScript never loses precision. */
  pgmq_msg_id: string | null;
}

export interface WhatsAppProcessResult {
  outcome: WhatsAppProcessOutcome;
  conversation_id?: string;
  message_created?: boolean;
}

export interface BusinessProfile {
  id: string;
  organization_id: string;
  business_name: string;
  greeting_message: string | null;
  operating_hours: Record<string, unknown>;
  escalation_email: string | null;
  escalation_phone: string | null;
  created_at: string;
  updated_at: string;
}

export interface WhatsAppConnection {
  id: string;
  organization_id: string;
  phone_number_id: string;
  waba_id: string | null;
  display_phone_number: string | null;
  access_token_ref: string | null;
  app_secret_ref: string | null;
  verify_token_ref: string | null;
  status: WhatsAppConnectionStatus;
  created_at: string;
  updated_at: string;
}

export interface WebhookEvent {
  id: string;
  organization_id: string | null;
  whatsapp_connection_id: string | null;
  provider: string;
  provider_event_id: string;
  event_kind: string;
  signature_verified: boolean;
  status: WebhookEventStatus;
  received_at: string;
  processed_at: string | null;
}

export interface InboundMessageStaging {
  webhook_event_id: string;
  organization_id: string;
  whatsapp_connection_id: string;
  contact_wa_id: string;
  message_type: string;
  body_text: string | null;
  wa_timestamp: string | null;
  created_at: string;
}

export interface Conversation {
  id: string;
  organization_id: string;
  whatsapp_connection_id: string;
  contact_wa_id: string;
  status: ConversationStatus;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  organization_id: string;
  conversation_id: string;
  whatsapp_connection_id: string;
  webhook_event_id: string | null;
  wa_message_id: string | null;
  direction: MessageDirection;
  status: MessageStatus;
  body: string | null;
  created_at: string;
  updated_at: string;
}

export interface FailedJob {
  id: string;
  webhook_event_id: string;
  queue_name: string;
  pgmq_msg_id: number;
  error: string;
  attempts: number;
  created_at: string;
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
      business_profiles: {
        Row: BusinessProfile;
        Insert: Omit<BusinessProfile, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<BusinessProfile>;
      };
      whatsapp_connections: {
        Row: WhatsAppConnection;
        Insert: Omit<WhatsAppConnection, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<WhatsAppConnection>;
      };
      webhook_events: {
        Row: WebhookEvent;
        Insert: Omit<WebhookEvent, 'id' | 'received_at'> & { id?: string; received_at?: string };
        Update: Partial<WebhookEvent>;
      };
      inbound_message_staging: {
        Row: InboundMessageStaging;
        Insert: Omit<InboundMessageStaging, 'created_at'> & { created_at?: string };
        Update: Partial<InboundMessageStaging>;
      };
      conversations: {
        Row: Conversation;
        Insert: Omit<Conversation, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<Conversation>;
      };
      messages: {
        Row: Message;
        Insert: Omit<Message, 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string; updated_at?: string };
        Update: Partial<Message>;
      };
      failed_jobs: {
        Row: FailedJob;
        Insert: Omit<FailedJob, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<FailedJob>;
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
      pgmq_send: {
        Args: {
          p_queue_name: string;
          p_message: Record<string, unknown>;
          p_delay_seconds?: number;
        };
        Returns: number;
      };
      pgmq_read: {
        Args: {
          p_queue_name: string;
          p_visibility_timeout_seconds: number;
          p_quantity: number;
        };
        Returns: Array<{
          msg_id: number;
          read_ct: number;
          enqueued_at: string;
          vt: string;
          message: Record<string, unknown>;
        }>;
      };
      pgmq_archive: {
        Args: {
          p_queue_name: string;
          p_msg_id: number;
        };
        Returns: boolean;
      };
      pgmq_delete: {
        Args: {
          p_queue_name: string;
          p_msg_id: number;
        };
        Returns: boolean;
      };
      ingest_whatsapp_message_event: {
        Args: {
          p_phone_number_id: string;
          p_provider_event_id: string;
          p_contact_wa_id: string;
          p_message_type: string;
          p_body_text?: string | null;
          p_wa_timestamp?: string | null;
          p_request_id?: string | null;
        };
        Returns: WhatsAppIngestResult;
      };
      process_whatsapp_inbound_receipt: {
        Args: {
          p_webhook_event_id: string;
        };
        Returns: WhatsAppProcessResult;
      };
      dead_letter_job: {
        Args: {
          p_queue_name: string;
          p_pgmq_msg_id: number;
          p_webhook_event_id: string;
          p_error: string;
          p_attempts: number;
        };
        Returns: boolean;
      };
    };
    Enums: {
      organization_role: OrganizationRole;
      invitation_status: InvitationStatus;
      whatsapp_connection_status: WhatsAppConnectionStatus;
      webhook_event_status: WebhookEventStatus;
      conversation_status: ConversationStatus;
      message_direction: MessageDirection;
      message_status: MessageStatus;
    };
  };
}
