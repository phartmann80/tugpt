import { NextResponse } from 'next/server';
import { defaultLogger } from '@tugpt/observability';
import { createAdminSupabaseClient } from '@tugpt/database';
import { verifyWhatsAppWebhookChallenge, verifyWhatsAppWebhookSignature } from '@tugpt/security';
import { PgMqJobQueue } from '@tugpt/jobs';
import { normalizeWhatsAppWebhookEnvelope } from '../../../../../whatsapp/normalize-webhook-envelope';

/**
 * WhatsApp Cloud API webhook endpoint -- Phase 3A secure asynchronous
 * inbound-message foundation.
 *
 * SCOPE BOUNDARY (Phase 3A, enforced structurally by this file's imports):
 * This route may only read the raw body, verify the signature, normalize
 * logical events, persist receipt metadata, enqueue record IDs, and return.
 * It has NO import of Mastra, Logicc, Langdock, any AI provider adapter, or
 * any orchestration package -- there is no code path from this file into
 * AI processing. AI draft generation happens nowhere in this route or in
 * apps/worker for Phase 3A.
 */

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error('Webhook route misconfigured: Supabase admin credentials are missing.');
  }
  return createAdminSupabaseClient(url, serviceRoleKey);
}

/**
 * GET /api/v1/webhooks/whatsapp -- Meta's webhook verification handshake.
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint/
 */
export async function GET(request: Request) {
  const requestId = request.headers.get('x-request-id') || `req-${Date.now()}`;
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  const expectedVerifyToken = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

  if (!expectedVerifyToken) {
    defaultLogger.error('WhatsApp webhook verification misconfigured: no verify token set', undefined, {
      requestId,
    });
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
  }

  if (verifyWhatsAppWebhookChallenge(mode, token, expectedVerifyToken)) {
    defaultLogger.info('WhatsApp webhook verification succeeded', { requestId, action: 'webhook.verify' });
    return new NextResponse(challenge ?? '', { status: 200 });
  }

  defaultLogger.error('WhatsApp webhook verification failed', undefined, { requestId, action: 'webhook.verify' });
  return NextResponse.json({ error: 'Verification failed' }, { status: 403 });
}

/**
 * POST /api/v1/webhooks/whatsapp -- inbound event ingestion.
 *
 * Sequence: read raw body -> verify signature -> normalize logical events
 * -> persist receipt metadata (webhook_events, idempotent) -> enqueue
 * record IDs (whatsapp_inbound_v1) -> return. No AI orchestration call
 * exists in this file.
 */
export async function POST(request: Request) {
  const requestId = request.headers.get('x-request-id') || `req-${Date.now()}`;
  const signatureHeader = request.headers.get('x-hub-signature-256');

  // Read the raw body exactly once, as text, before any parsing -- the
  // signature must be verified against the exact bytes Meta signed.
  const rawBody = await request.text();

  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) {
    defaultLogger.error('WhatsApp webhook misconfigured: no app secret set', undefined, { requestId });
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
  }

  const signatureValid = verifyWhatsAppWebhookSignature(rawBody, signatureHeader, appSecret);

  if (!signatureValid) {
    // Invalid signature: no DB receipt, no queued message. Logged only,
    // per the Phase 3A requirement.
    defaultLogger.error('WhatsApp webhook signature verification failed', undefined, {
      requestId,
      action: 'webhook.signature_invalid',
    });
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const events = normalizeWhatsAppWebhookEnvelope(rawBody);

  if (events.length === 0) {
    // Valid signature but nothing to process (e.g. a status callback, not
    // a message). Acknowledge with 200 so Meta does not retry.
    defaultLogger.info('WhatsApp webhook received with no logical message events', {
      requestId,
      action: 'webhook.no_events',
    });
    return NextResponse.json({ received: true, events: 0 });
  }

  const supabase = getAdminClient();
  const jobQueue = new PgMqJobQueue(supabase);

  let queuedCount = 0;
  let duplicateCount = 0;

  for (const event of events) {
    // Resolve the owning organization from the connection's phone_number_id
    // -- this route is unauthenticated by design (Meta calls it directly),
    // so tenant resolution happens by connection lookup, never by session.
    const { data: connectionData, error: connectionError } = await supabase
      .from('whatsapp_connections')
      .select('id, organization_id')
      .eq('phone_number_id', event.phoneNumberId)
      .maybeSingle();

    const connection = connectionData as unknown as { id: string; organization_id: string } | null;

    if (connectionError || !connection) {
      defaultLogger.error('WhatsApp webhook event references unknown connection', connectionError ?? undefined, {
        requestId,
        action: 'webhook.unknown_connection',
      });
      continue;
    }

    // Idempotent receipt insert: (provider, provider_event_id) is unique.
    // A duplicate delivery of the same message.id is a no-op here, not an
    // error -- and produces no new queue entry.
    const { data: insertedEventData, error: insertError } = await supabase
      .from('webhook_events')
      .insert({
        organization_id: connection.organization_id,
        whatsapp_connection_id: connection.id,
        provider: 'whatsapp',
        provider_event_id: event.providerEventId,
        signature_verified: true,
        status: 'received',
        contact_wa_id: event.contactWaId,
        message_type: event.messageType,
        body_text: event.body,
        wa_timestamp: event.timestamp,
      } as never)
      .select('id')
      .single();

    if (insertError) {
      // Unique violation => duplicate delivery, expected and not an error.
      if ((insertError as { code?: string }).code === '23505') {
        duplicateCount += 1;
        continue;
      }
      defaultLogger.error('Failed to persist webhook_events receipt', insertError, {
        requestId,
        action: 'webhook.receipt_failed',
      });
      continue;
    }

    const insertedEvent = insertedEventData as unknown as { id: string } | null;

    if (!insertedEvent) {
      defaultLogger.error('webhook_events insert returned no row despite no error', undefined, {
        requestId,
        action: 'webhook.receipt_failed',
      });
      continue;
    }

    // Enqueue IDs and correlation metadata ONLY -- no message body, no
    // token, no phone-number PII, no raw webhook JSON on the queue.
    await jobQueue.enqueue('whatsapp.process_message', {
      organizationId: connection.organization_id,
      requestId,
      timestamp: new Date().toISOString(),
      webhookEventId: insertedEvent.id,
      whatsappConnectionId: connection.id,
    });

    queuedCount += 1;
  }

  defaultLogger.info('WhatsApp webhook processed', {
    requestId,
    action: 'webhook.processed',
    queuedCount,
    duplicateCount,
    totalEvents: events.length,
  });

  return NextResponse.json({ received: true, queued: queuedCount, duplicates: duplicateCount });
}
