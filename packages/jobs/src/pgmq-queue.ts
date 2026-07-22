import type { TypedSupabaseClient, WhatsAppIngestResult } from '@tugpt/database';
import type { BaseJobPayload, JobHandler, JobQueueAdapter, JobType } from './types';

/**
 * Supabase Queues (pgmq) adapter for server-side background work.
 *
 * Phase 3A has one additional invariant: a WhatsApp receipt and its queue
 * item must be created atomically. Call ingestWhatsAppMessageEvent() for
 * inbound WhatsApp work; enqueue('whatsapp.process_message', ...) is rejected
 * so application code cannot reintroduce a split insert/enqueue path.
 */

export const WHATSAPP_INBOUND_QUEUE = 'whatsapp_inbound_v1' as const;

/** Normalized content passed to the atomic database ingestion RPC. */
export interface WhatsAppMessageEventInput {
  phoneNumberId: string;
  providerEventId: string;
  contactWaId: string;
  messageType: string;
  body: string | null;
  timestamp: string | null;
  requestId?: string;
}

/**
 * The complete pgmq payload shape. It contains one authoritative receipt ID
 * plus non-sensitive correlation metadata. Tenant identity and customer
 * content are intentionally absent and must be derived inside the worker RPC.
 */
export interface WhatsAppInboundJobPayload {
  webhookEventId: string;
  requestId?: string;
  timestamp: string;
}

export interface PgMqReadResult<TPayload> {
  pgmqMsgId: number;
  readCount: number;
  enqueuedAt: string;
  payload: TPayload;
}

export interface PgMqJobQueueOptions {
  visibilityTimeoutSeconds?: number;
  maxAttempts?: number;
}

const DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 60;
const DEFAULT_MAX_ATTEMPTS = 5;
const INGEST_OUTCOMES = new Set(['queued', 'duplicate', 'unknown_connection']);

function parseIngestResult(value: unknown): WhatsAppIngestResult {
  if (!value || typeof value !== 'object') {
    throw new Error('ingest_whatsapp_message_event returned an invalid result');
  }

  const result = value as Partial<WhatsAppIngestResult>;
  if (!result.outcome || !INGEST_OUTCOMES.has(result.outcome)) {
    throw new Error('ingest_whatsapp_message_event returned an unknown outcome');
  }

  return {
    outcome: result.outcome,
    webhook_event_id: typeof result.webhook_event_id === 'string' ? result.webhook_event_id : null,
    pgmq_msg_id: typeof result.pgmq_msg_id === 'string' ? result.pgmq_msg_id : null,
  };
}

export class PgMqJobQueue implements JobQueueAdapter {
  private readonly visibilityTimeoutSeconds: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly supabase: TypedSupabaseClient,
    options: PgMqJobQueueOptions = {}
  ) {
    this.visibilityTimeoutSeconds = options.visibilityTimeoutSeconds ?? DEFAULT_VISIBILITY_TIMEOUT_SECONDS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  /**
   * Atomically resolves the registered connection, creates a metadata-only
   * receipt, stages normalized content, and enqueues the receipt ID.
   */
  async ingestWhatsAppMessageEvent(input: WhatsAppMessageEventInput): Promise<WhatsAppIngestResult> {
    const { data, error } = await this.supabase.rpc(
      'ingest_whatsapp_message_event',
      {
        p_phone_number_id: input.phoneNumberId,
        p_provider_event_id: input.providerEventId,
        p_contact_wa_id: input.contactWaId,
        p_message_type: input.messageType,
        p_body_text: input.body,
        p_wa_timestamp: input.timestamp,
        p_request_id: input.requestId ?? null,
      } as unknown as undefined
    );

    if (error) {
      throw new Error(`Atomic WhatsApp ingestion failed: ${error.message}`);
    }

    return parseIngestResult(data);
  }

  /**
   * Generic enqueue remains available for future job types. WhatsApp inbound
   * work is rejected here because it must use the atomic ingestion RPC.
   */
  async enqueue<TPayload extends BaseJobPayload>(
    type: JobType,
    payload: TPayload,
    options?: { delayMs?: number; maxAttempts?: number }
  ): Promise<{ jobId: string }> {
    if (type === 'whatsapp.process_message') {
      throw new Error('WhatsApp inbound jobs must use ingestWhatsAppMessageEvent()');
    }

    const queueName = this.resolveQueueName(type);
    const delaySeconds = Math.max(0, Math.floor((options?.delayMs ?? 0) / 1000));

    const { data, error } = await this.supabase.rpc(
      'pgmq_send',
      {
        p_queue_name: queueName,
        p_message: payload as unknown as Record<string, unknown>,
        p_delay_seconds: delaySeconds,
      } as unknown as undefined
    );

    if (error) {
      throw new Error(`PgMqJobQueue.enqueue failed for queue "${queueName}": ${error.message}`);
    }

    return { jobId: String(data) };
  }

  /** Worker-only queue read. */
  async poll<TPayload>(queueName: string, quantity = 1): Promise<PgMqReadResult<TPayload>[]> {
    const { data, error } = await this.supabase.rpc(
      'pgmq_read',
      {
        p_queue_name: queueName,
        p_visibility_timeout_seconds: this.visibilityTimeoutSeconds,
        p_quantity: quantity,
      } as unknown as undefined
    );

    if (error) {
      throw new Error(`PgMqJobQueue.poll failed for queue "${queueName}": ${error.message}`);
    }

    const rows = (data ?? []) as Array<{
      msg_id: number;
      read_ct: number;
      enqueued_at: string;
      message: TPayload;
    }>;

    return rows.map((row) => ({
      pgmqMsgId: row.msg_id,
      readCount: row.read_ct,
      enqueuedAt: row.enqueued_at,
      payload: row.message,
    }));
  }

  /** Worker-only archive after successful processing. */
  async ackSuccess(queueName: string, pgmqMsgId: number): Promise<void> {
    const { error } = await this.supabase.rpc(
      'pgmq_archive',
      { p_queue_name: queueName, p_msg_id: pgmqMsgId } as unknown as undefined
    );

    if (error) {
      throw new Error(`PgMqJobQueue.ackSuccess failed for queue "${queueName}" msg ${pgmqMsgId}: ${error.message}`);
    }
  }

  /**
   * Leaves a job visible for retry until maxAttempts, then atomically creates
   * the narrow failed_jobs row and archives the pgmq item. Only the receipt ID
   * is forwarded; no queue payload copy or tenant claim is persisted.
   */
  async ackFailure(
    queueName: string,
    pgmqMsgId: number,
    readCount: number,
    payload: WhatsAppInboundJobPayload,
    error: string
  ): Promise<{ deadLettered: boolean }> {
    if (readCount < this.maxAttempts) {
      return { deadLettered: false };
    }

    if (!payload || typeof payload.webhookEventId !== 'string' || payload.webhookEventId.length === 0) {
      throw new Error('Cannot dead-letter a WhatsApp job without a webhookEventId');
    }

    const { data, error: rpcError } = await this.supabase.rpc(
      'dead_letter_job',
      {
        p_queue_name: queueName,
        p_pgmq_msg_id: pgmqMsgId,
        p_webhook_event_id: payload.webhookEventId,
        p_error: error,
        p_attempts: readCount,
      } as unknown as undefined
    );

    if (rpcError) {
      throw new Error(`PgMqJobQueue.ackFailure could not atomically dead-letter the job: ${rpcError.message}`);
    }

    if (data !== true) {
      throw new Error('PgMqJobQueue.ackFailure received an invalid dead-letter result');
    }

    return { deadLettered: true };
  }

  get configuredMaxAttempts(): number {
    return this.maxAttempts;
  }

  private resolveQueueName(type: JobType): string {
    return type.replace(/\./g, '_');
  }
}

export class PgMqHandlerRegistry {
  private handlers: Map<JobType, JobHandler> = new Map();

  public registerHandler(handler: JobHandler): void {
    this.handlers.set(handler.jobType, handler);
  }

  public getHandler(type: JobType): JobHandler | undefined {
    return this.handlers.get(type);
  }
}
