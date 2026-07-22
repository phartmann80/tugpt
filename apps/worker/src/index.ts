import { createAdminSupabaseClient } from '@tugpt/database';
import { defaultLogger } from '@tugpt/observability';
import { WHATSAPP_INBOUND_QUEUE, type WhatsAppInboundJobPayload } from '@tugpt/jobs';
import { processWhatsAppInboundJob } from './whatsapp-inbound-processor';
import { PgMqJobQueue } from '@tugpt/jobs';

/**
 * apps/worker -- dedicated Node worker process (Phase 3A).
 *
 * This process, not any Next.js route, is the ONLY code path permitted to
 * consume the whatsapp_inbound_v1 queue. It:
 *   1. polls the queue for a batch of messages,
 *   2. passes only the receipt ID to the atomic processing RPC,
 *   3. lets the database derive tenancy and persist the message,
 *   4. marks the receipt processed without resetting conversation state,
 *   5. archives the queue item.
 *
 * It does NOT generate an AI reply in Phase 3A -- there is no import of any
 * orchestration or provider package in this file or in
 * whatsapp-inbound-processor.ts.
 */

const POLL_INTERVAL_MS = 2000;
const POLL_BATCH_SIZE = 5;

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error('Worker misconfigured: Supabase admin credentials are missing.');
  }
  return createAdminSupabaseClient(url, serviceRoleKey);
}

export async function runOnce(queue: PgMqJobQueue, supabase: ReturnType<typeof createAdminSupabaseClient>) {
  const messages = await queue.poll<WhatsAppInboundJobPayload>(WHATSAPP_INBOUND_QUEUE, POLL_BATCH_SIZE);

  for (const msg of messages) {
    try {
      await processWhatsAppInboundJob(supabase, msg.payload);
      await queue.ackSuccess(WHATSAPP_INBOUND_QUEUE, msg.pgmqMsgId);
    } catch (err) {
      const error = err as Error;
      defaultLogger.error('WhatsApp inbound job processing failed', error, {
        action: 'worker.job_failed',
        pgmqMsgId: msg.pgmqMsgId,
        readCount: msg.readCount,
      });

      const { deadLettered } = await queue.ackFailure(
        WHATSAPP_INBOUND_QUEUE,
        msg.pgmqMsgId,
        msg.readCount,
        msg.payload,
        error.message
      );

      if (deadLettered) {
        defaultLogger.error('WhatsApp inbound job dead-lettered after max attempts', error, {
          action: 'worker.dead_lettered',
          pgmqMsgId: msg.pgmqMsgId,
        });
      }
    }
  }

  return messages.length;
}

async function main() {
  const supabase = getAdminClient();
  const queue = new PgMqJobQueue(supabase);

  defaultLogger.info('WhatsApp inbound worker starting', { action: 'worker.start' });

  while (true) {
    const processedCount = await runOnce(queue, supabase);
    if (processedCount === 0) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    defaultLogger.error('WhatsApp inbound worker crashed', err as Error, { action: 'worker.crash' });
    process.exit(1);
  });
}
