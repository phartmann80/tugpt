import type { TypedSupabaseClient } from '@tugpt/database';
import type { BaseJobPayload, JobHandler, JobQueueAdapter, JobType } from './types';

/**
 * PgMqJobQueue -- Supabase Queues (pgmq) backed implementation of the
 * existing JobQueueAdapter contract (ADR-007).
 *
 * Decisions fixed for Phase 3 (see docs/status and the Phase 3 plan):
 * - Queue backend is Supabase Queues / pgmq. Redis, BullMQ, and pg-boss are
 *   not used.
 * - The Next.js webhook route may only call `enqueue()` (validate, persist,
 *   enqueue, return). It must never call `poll()` / `ackSuccess()` /
 *   `ackFailure()` -- those belong exclusively to a worker process
 *   (apps/worker), never to a request-handling route. This module does not
 *   enforce that boundary by itself; it is enforced by which processes are
 *   permitted to import from apps/worker (see apps/worker/README.md and the
 *   Phase 3A PR description).
 * - Queue payloads may only ever contain IDs and correlation metadata -- see
 *   WhatsAppInboundJobPayload below. No message body, access token,
 *   phone-number PII, or raw webhook JSON is ever placed on the queue.
 *
 * pgmq itself is not exposed over PostgREST; this class calls the
 * SECURITY DEFINER RPC wrappers added in
 * supabase/migrations/20260721153006_phase3a_webhook_foundation.sql
 * (pgmq_send / pgmq_read / pgmq_archive / pgmq_delete), which are granted to
 * service_role only. A PgMqJobQueue must always be constructed with an
 * admin (service-role) Supabase client -- never the anon/browser client.
 */

export const WHATSAPP_INBOUND_QUEUE = 'whatsapp_inbound_v1' as const;

/**
 * The only payload shape enqueued in Phase 3A. Deliberately minimal: IDs
 * and correlation metadata only. Adding a field here that carries message
 * content, a token, or PII would violate the Phase 3A security requirement
 * and must not be done without a documented, reviewed exception.
 */
export interface WhatsAppInboundJobPayload extends BaseJobPayload {
  webhookEventId: string;
  organizationId: string;
  whatsappConnectionId: string;
}

export interface PgMqReadResult<TPayload> {
  pgmqMsgId: number;
  readCount: number;
  enqueuedAt: string;
  payload: TPayload;
}

export interface PgMqJobQueueOptions {
  /** Visibility timeout in seconds. Proposed default: 60s (see Phase 3 plan). */
  visibilityTimeoutSeconds?: number;
  /** Max read attempts before a message is moved to failed_jobs and archived. */
  maxAttempts?: number;
}

const DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 60;
const DEFAULT_MAX_ATTEMPTS = 5;

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
   * Enqueue a job. This is the ONLY method a Next.js route handler is
   * permitted to call -- it must not read the queue back or process jobs
   * inline.
   */
  async enqueue<TPayload extends BaseJobPayload>(
    type: JobType,
    payload: TPayload,
    options?: { delayMs?: number; maxAttempts?: number }
  ): Promise<{ jobId: string }> {
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

  /**
   * Read up to `quantity` messages from a queue with the configured
   * visibility timeout. Worker-only -- never called from a route handler.
   */
  async poll<TPayload>(
    queueName: string,
    quantity = 1
  ): Promise<PgMqReadResult<TPayload>[]> {
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

  /**
   * Archive a message after successful processing. Worker-only.
   */
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
   * Called by the worker when a message has exhausted `maxAttempts`. Writes
   * a failed_jobs record and archives the message out of the active queue
   * (never deletes it outright, per the Phase 3A requirement for a
   * dead-letter record).
   */
  async ackFailure(
    queueName: string,
    pgmqMsgId: number,
    readCount: number,
    payload: unknown,
    error: string,
    organizationId?: string
  ): Promise<{ deadLettered: boolean }> {
    if (readCount < this.maxAttempts) {
      // Let the visibility timeout expire naturally for a retry -- do not
      // archive, do not delete.
      return { deadLettered: false };
    }

    const { error: insertError } = await this.supabase
      .from('failed_jobs')
      .insert({
        organization_id: organizationId ?? null,
        queue_name: queueName,
        pgmq_msg_id: pgmqMsgId,
        payload: payload as never,
        error,
        attempts: readCount,
      } as never);

    if (insertError) {
      throw new Error(`PgMqJobQueue.ackFailure could not write failed_jobs record: ${insertError.message}`);
    }

    await this.ackSuccess(queueName, pgmqMsgId); // archive out of the active queue
    return { deadLettered: true };
  }

  get configuredMaxAttempts(): number {
    return this.maxAttempts;
  }

  private resolveQueueName(type: JobType): string {
    if (type === 'whatsapp.process_message') {
      return WHATSAPP_INBOUND_QUEUE;
    }
    // Phase 3A introduces exactly one queue. Other job types fall back to a
    // type-derived queue name so the adapter remains usable for future job
    // types without a schema change -- but no such queue is provisioned by
    // Phase 3A, and enqueueing to one would fail loudly (pgmq.send raises if
    // the queue does not exist), which is the desired behavior over silent
    // misrouting.
    return type.replace(/\./g, '_');
  }
}

/**
 * Handler registry kept for interface parity with InMemoryJobQueue. Not
 * used by the webhook route (which only calls enqueue()) or by the worker
 * in Phase 3A (which implements its own loop against the same RPC surface
 * directly via PgMqJobQueue.poll/ackSuccess/ackFailure, not via a
 * registered handler map) -- included so a future slice can adopt the same
 * `registerHandler` shape as InMemoryJobQueue if useful.
 */
export class PgMqHandlerRegistry {
  private handlers: Map<JobType, JobHandler> = new Map();

  public registerHandler(handler: JobHandler): void {
    this.handlers.set(handler.jobType, handler);
  }

  public getHandler(type: JobType): JobHandler | undefined {
    return this.handlers.get(type);
  }
}
