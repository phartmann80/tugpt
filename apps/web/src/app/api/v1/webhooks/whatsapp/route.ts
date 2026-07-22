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
 * logical events, call the atomic ingestion RPC, and return.
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

  if (challenge !== null && verifyWhatsAppWebhookChallenge(mode, token, expectedVerifyToken)) {
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
 * -> call one transactional receipt/staging/enqueue RPC per event -> return.
 * No direct table write, split enqueue, or AI orchestration call exists here.
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

  let jobQueue: PgMqJobQueue;
  try {
    jobQueue = new PgMqJobQueue(getAdminClient());
  } catch (error) {
    defaultLogger.error('WhatsApp webhook ingestion is misconfigured', error as Error, {
      requestId,
      action: 'webhook.configuration_error',
    });
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
  }

  let queuedCount = 0;
  let duplicateCount = 0;
  let ignoredCount = 0;

  for (const event of events) {
    try {
      const result = await jobQueue.ingestWhatsAppMessageEvent({
        phoneNumberId: event.phoneNumberId,
        providerEventId: event.providerEventId,
        contactWaId: event.contactWaId,
        messageType: event.messageType,
        body: event.body,
        timestamp: event.timestamp,
        requestId,
      });

      if (result.outcome === 'queued') {
        queuedCount += 1;
      } else if (result.outcome === 'duplicate') {
        duplicateCount += 1;
      } else {
        ignoredCount += 1;
        defaultLogger.error('WhatsApp webhook event references an unknown or inactive connection', undefined, {
          requestId,
          action: 'webhook.unknown_connection',
        });
      }
    } catch (error) {
      // Return a retryable failure. Any earlier events in this envelope were
      // committed atomically; Meta's replay will deduplicate them and retry
      // this event without producing a second receipt or queue item.
      defaultLogger.error('Atomic WhatsApp webhook ingestion failed', error as Error, {
        requestId,
        action: 'webhook.ingestion_failed',
      });
      return NextResponse.json({ error: 'Webhook ingestion temporarily unavailable' }, { status: 503 });
    }
  }

  defaultLogger.info('WhatsApp webhook processed', {
    requestId,
    action: 'webhook.processed',
    queuedCount,
    duplicateCount,
    ignoredCount,
    totalEvents: events.length,
  });

  return NextResponse.json({
    received: true,
    queued: queuedCount,
    duplicates: duplicateCount,
    ignored: ignoredCount,
  });
}
