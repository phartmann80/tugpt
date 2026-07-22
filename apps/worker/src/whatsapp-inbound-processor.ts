import type { TypedSupabaseClient, WhatsAppProcessOutcome, WhatsAppProcessResult } from '@tugpt/database';
import type { WhatsAppInboundJobPayload } from '@tugpt/jobs';

const PROCESS_OUTCOMES = new Set<WhatsAppProcessOutcome>(['processed', 'already_processed']);

/**
 * Processes one receipt through the database's atomic worker RPC.
 *
 * The queue is deliberately untrusted for tenant identity. organizationId,
 * whatsappConnectionId, contact IDs, and message content are neither needed
 * nor read here; the RPC locks the receipt/staging rows and derives every
 * tenant-scoped value from those authoritative records.
 */
export async function processWhatsAppInboundJob(
  supabase: TypedSupabaseClient,
  payload: WhatsAppInboundJobPayload
): Promise<WhatsAppProcessOutcome> {
  if (!payload || typeof payload.webhookEventId !== 'string' || payload.webhookEventId.length === 0) {
    throw new Error('WhatsApp inbound job is missing webhookEventId');
  }

  const { data, error } = await supabase.rpc(
    'process_whatsapp_inbound_receipt',
    { p_webhook_event_id: payload.webhookEventId } as unknown as undefined
  );

  if (error) {
    throw new Error(`Failed to process webhook receipt ${payload.webhookEventId}: ${error.message}`);
  }

  if (!data || typeof data !== 'object') {
    throw new Error(`Processing webhook receipt ${payload.webhookEventId} returned an invalid result`);
  }

  const result = data as Partial<WhatsAppProcessResult>;
  if (!result.outcome || !PROCESS_OUTCOMES.has(result.outcome)) {
    throw new Error(`Processing webhook receipt ${payload.webhookEventId} returned an unknown outcome`);
  }

  return result.outcome;
}
