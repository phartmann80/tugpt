import { describe, expect, it, vi } from 'vitest';
import {
  PgMqJobQueue,
  WHATSAPP_INBOUND_QUEUE,
  type WhatsAppInboundJobPayload,
  type WhatsAppMessageEventInput,
} from './pgmq-queue';
import type { TypedSupabaseClient } from '@tugpt/database';

function createMockSupabase(rpcImpl: (fn: string, args: unknown) => Promise<{ data: unknown; error: unknown }>) {
  return { rpc: vi.fn().mockImplementation(rpcImpl) } as unknown as TypedSupabaseClient;
}

function eventInput(): WhatsAppMessageEventInput {
  return {
    phoneNumberId: 'pn-1',
    providerEventId: 'wamid.1',
    contactWaId: 'contact-1',
    messageType: 'text',
    body: 'hello',
    timestamp: '1700000000',
    requestId: 'req-1',
  };
}

function queuePayload(): WhatsAppInboundJobPayload {
  return {
    requestId: 'req-1',
    timestamp: '2026-01-01T00:00:00Z',
    webhookEventId: 'receipt-1',
  };
}

describe('PgMqJobQueue.ingestWhatsAppMessageEvent', () => {
  it('calls the single atomic ingestion RPC with normalized fields', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { outcome: 'queued', webhook_event_id: 'receipt-1', pgmq_msg_id: '42' },
      error: null,
    });
    const queue = new PgMqJobQueue(createMockSupabase(rpc));

    const result = await queue.ingestWhatsAppMessageEvent(eventInput());

    expect(rpc).toHaveBeenCalledWith('ingest_whatsapp_message_event', {
      p_phone_number_id: 'pn-1',
      p_provider_event_id: 'wamid.1',
      p_contact_wa_id: 'contact-1',
      p_message_type: 'text',
      p_body_text: 'hello',
      p_wa_timestamp: '1700000000',
      p_request_id: 'req-1',
    });
    expect(result).toEqual({ outcome: 'queued', webhook_event_id: 'receipt-1', pgmq_msg_id: '42' });
  });

  it.each(['duplicate', 'unknown_connection'] as const)('maps the %s outcome without inventing IDs', async (outcome) => {
    const rpc = vi.fn().mockResolvedValue({
      data: { outcome, webhook_event_id: null, pgmq_msg_id: null },
      error: null,
    });
    const queue = new PgMqJobQueue(createMockSupabase(rpc));

    await expect(queue.ingestWhatsAppMessageEvent(eventInput())).resolves.toMatchObject({ outcome });
  });

  it('throws when the atomic RPC fails so the webhook can request a retry', async () => {
    const queue = new PgMqJobQueue(
      createMockSupabase(vi.fn().mockResolvedValue({ data: null, error: { message: 'pgmq send failed' } }))
    );

    await expect(queue.ingestWhatsAppMessageEvent(eventInput())).rejects.toThrow(/pgmq send failed/);
  });

  it('rejects an unknown RPC outcome', async () => {
    const queue = new PgMqJobQueue(
      createMockSupabase(vi.fn().mockResolvedValue({ data: { outcome: 'surprise' }, error: null }))
    );

    await expect(queue.ingestWhatsAppMessageEvent(eventInput())).rejects.toThrow(/unknown outcome/);
  });

  it('blocks the legacy split enqueue path for WhatsApp inbound work', async () => {
    const rpc = vi.fn();
    const queue = new PgMqJobQueue(createMockSupabase(rpc));

    await expect(
      queue.enqueue('whatsapp.process_message', {
        organizationId: 'forged-org',
        timestamp: '2026-01-01T00:00:00Z',
      })
    ).rejects.toThrow(/ingestWhatsAppMessageEvent/);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('PgMqJobQueue generic queue operations', () => {
  it('keeps generic enqueue available for non-WhatsApp job types', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 9, error: null });
    const queue = new PgMqJobQueue(createMockSupabase(rpc));

    const result = await queue.enqueue('appointment.send_reminder', {
      organizationId: 'org-1',
      timestamp: '2026-01-01T00:00:00Z',
    });

    expect(result.jobId).toBe('9');
    expect(rpc).toHaveBeenCalledWith(
      'pgmq_send',
      expect.objectContaining({ p_queue_name: 'appointment_send_reminder' })
    );
  });

  it('maps pgmq_read rows into PgMqReadResult', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ msg_id: 7, read_ct: 1, enqueued_at: '2026-01-01T00:00:00Z', message: queuePayload() }],
      error: null,
    });
    const queue = new PgMqJobQueue(createMockSupabase(rpc));

    const results = await queue.poll<WhatsAppInboundJobPayload>(WHATSAPP_INBOUND_QUEUE, 1);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ pgmqMsgId: 7, readCount: 1, payload: { webhookEventId: 'receipt-1' } });
  });
});

describe('PgMqJobQueue.ackFailure', () => {
  it('does not write or archive before maxAttempts is reached', async () => {
    const rpc = vi.fn();
    const queue = new PgMqJobQueue(createMockSupabase(rpc), { maxAttempts: 5 });

    await expect(queue.ackFailure(WHATSAPP_INBOUND_QUEUE, 1, 2, queuePayload(), 'boom')).resolves.toEqual({
      deadLettered: false,
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('uses one atomic dead-letter RPC with only receipt identity and diagnostics', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    const queue = new PgMqJobQueue(createMockSupabase(rpc), { maxAttempts: 3 });

    const result = await queue.ackFailure(WHATSAPP_INBOUND_QUEUE, 11, 3, queuePayload(), 'boom');

    expect(result).toEqual({ deadLettered: true });
    expect(rpc).toHaveBeenCalledWith('dead_letter_job', {
      p_queue_name: WHATSAPP_INBOUND_QUEUE,
      p_pgmq_msg_id: 11,
      p_webhook_event_id: 'receipt-1',
      p_error: 'boom',
      p_attempts: 3,
    });
    const args = rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(args).not.toHaveProperty('p_payload');
    expect(args).not.toHaveProperty('p_organization_id');
  });

  it('does not separately archive when atomic dead-lettering fails', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'archive failed' } });
    const queue = new PgMqJobQueue(createMockSupabase(rpc), { maxAttempts: 1 });

    await expect(queue.ackFailure(WHATSAPP_INBOUND_QUEUE, 11, 1, queuePayload(), 'boom')).rejects.toThrow(
      /archive failed/
    );
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).not.toHaveBeenCalledWith('pgmq_archive', expect.anything());
  });
});
