import type { TypedSupabaseClient, WebhookEvent } from '@tugpt/database';
import type { WhatsAppInboundJobPayload } from '@tugpt/jobs';

/**
 * Loads the verified webhook_events receipt referenced by the job payload
 * and deterministically persists the inbound conversation/message.
 *
 * Deterministic + idempotent by construction:
 *   - conversations is unique on (whatsapp_connection_id, contact_wa_id) --
 *     re-running this for the same contact upserts into the same
 *     conversation row rather than creating a duplicate.
 *   - messages is unique on (whatsapp_connection_id, wa_message_id) -- a
 *     redelivered queue message (pgmq guarantees at-least-once, not
 *     exactly-once) that reaches this function twice for the same
 *     provider_event_id produces exactly one message row, not two.
 *
 * Does NOT generate an AI reply and does not import any orchestration or
 * provider package -- Phase 3A stops at persisting the inbound message and
 * marking the receipt processed.
 */
export async function processWhatsAppInboundJob(
  supabase: TypedSupabaseClient,
  payload: WhatsAppInboundJobPayload
): Promise<void> {
  const { data: receiptData, error: receiptError } = await supabase
    .from('webhook_events')
    .select('*')
    .eq('id', payload.webhookEventId)
    .single();

  const receipt = receiptData as unknown as WebhookEvent | null;

  if (receiptError || !receipt) {
    throw new Error(`Referenced webhook_events receipt ${payload.webhookEventId} not found: ${receiptError?.message}`);
  }

  if (!receipt.signature_verified) {
    // Should be structurally impossible (the route never enqueues an
    // unverified event), but fail loudly rather than silently trusting an
    // unverified receipt if this invariant is ever violated upstream.
    throw new Error(`Refusing to process unverified webhook_events receipt ${receipt.id}`);
  }

  if (receipt.status === 'processed') {
    // Idempotent no-op: already processed by an earlier delivery of this
    // job (pgmq at-least-once redelivery).
    return;
  }

  if (!receipt.contact_wa_id) {
    throw new Error(`webhook_events receipt ${receipt.id} has no contact_wa_id -- cannot create a conversation`);
  }

  // Upsert the conversation for this contact on this connection.
  const { data: conversationData, error: conversationError } = await supabase
    .from('conversations')
    .upsert(
      {
        organization_id: payload.organizationId,
        whatsapp_connection_id: payload.whatsappConnectionId,
        contact_wa_id: receipt.contact_wa_id,
        status: 'open',
      } as never,
      { onConflict: 'whatsapp_connection_id,contact_wa_id', ignoreDuplicates: false }
    )
    .select('id')
    .single();

  const conversation = conversationData as unknown as { id: string } | null;

  if (conversationError || !conversation) {
    throw new Error(`Failed to upsert conversation for receipt ${receipt.id}: ${conversationError?.message}`);
  }

  // Insert the message. Idempotent on (whatsapp_connection_id,
  // wa_message_id) -- a duplicate insert from a redelivered job is a
  // no-op, not an error.
  const { error: messageError } = await supabase
    .from('messages')
    .insert({
      organization_id: payload.organizationId,
      conversation_id: conversation.id,
      whatsapp_connection_id: payload.whatsappConnectionId,
      webhook_event_id: receipt.id,
      wa_message_id: receipt.provider_event_id,
      direction: 'inbound',
      status: 'received',
      body: receipt.body_text,
    } as never);

  if (messageError && (messageError as { code?: string }).code !== '23505') {
    throw new Error(`Failed to insert message for receipt ${receipt.id}: ${messageError.message}`);
  }

  const { error: updateError } = await supabase
    .from('webhook_events')
    .update({ status: 'processed', processed_at: new Date().toISOString() } as never)
    .eq('id', receipt.id);

  if (updateError) {
    throw new Error(`Failed to mark webhook_events receipt ${receipt.id} processed: ${updateError.message}`);
  }
}
