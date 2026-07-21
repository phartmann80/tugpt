import { describe, expect, it, vi } from 'vitest';
import { PgMqJobQueue, WHATSAPP_INBOUND_QUEUE, type WhatsAppInboundJobPayload } from './pgmq-queue';
import type { TypedSupabaseClient } from '@tugpt/database';

function createMockSupabase(rpcImpl: (fn: string, args: unknown) => Promise<{ data: unknown; error: unknown }>) {
  return {
    rpc: vi.fn().mockImplementation(rpcImpl),
    from: vi.fn(),
  } as unknown as TypedSupabaseClient;
}

function payload(): WhatsAppInboundJobPayload {
  return {
    organizationId: 'org-1',
    requestId: 'req-1',
    timestamp: new Date().toISOString(),
    webhookEventId: 'receipt-1',
    whatsappConnectionId: 'conn-1',
  };
}

describe('PgMqJobQueue.enqueue', () => {
  it('calls pgmq_send against the named inbound WhatsApp queue', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 42, error: null });
    const supabase = createMockSupabase(rpc);
    const queue = new PgMqJobQueue(supabase);

    const result = await queue.enqueue('whatsapp.process_message', payload());

    expect(rpc).toHaveBeenCalledWith(
      'pgmq_send',
      expect.objectContaining({ p_queue_name: WHATSAPP_INBOUND_QUEUE })
    );
    expect(result.jobId).toBe('42');
  });

  it('enqueues only IDs and correlation metadata -- no message body, token, or PII fields', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 1, error: null });
    const supabase = createMockSupabase(rpc);
    const queue = new PgMqJobQueue(supabase);

    await queue.enqueue('whatsapp.process_message', payload());

    const [, args] = rpc.mock.calls[0];
    const message = (args as { p_message: Record<string, unknown> }).p_message;
    const keys = Object.keys(message);

    expect(keys).toEqual(
      expect.arrayContaining(['organizationId', 'requestId', 'timestamp', 'webhookEventId', 'whatsappConnectionId'])
    );
    expect(keys).not.toContain('body');
    expect(keys).not.toContain('accessToken');
    expect(keys).not.toContain('phoneNumber');
    expect(keys).not.toContain('rawPayload');
  });

  it('throws when pgmq_send returns an error', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'queue does not exist' } });
    const supabase = createMockSupabase(rpc);
    const queue = new PgMqJobQueue(supabase);

    await expect(queue.enqueue('whatsapp.process_message', payload())).rejects.toThrow(/queue does not exist/);
  });
});

describe('PgMqJobQueue.poll', () => {
  it('maps pgmq_read rows into PgMqReadResult', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ msg_id: 7, read_ct: 1, enqueued_at: '2026-01-01T00:00:00Z', message: payload() }],
      error: null,
    });
    const supabase = createMockSupabase(rpc);
    const queue = new PgMqJobQueue(supabase);

    const results = await queue.poll(WHATSAPP_INBOUND_QUEUE, 1);

    expect(results).toHaveLength(1);
    expect(results[0].pgmqMsgId).toBe(7);
    expect(results[0].readCount).toBe(1);
  });
});

describe('PgMqJobQueue.ackFailure', () => {
  it('does not dead-letter before maxAttempts is reached', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const supabase = createMockSupabase(rpc);
    const queue = new PgMqJobQueue(supabase, { maxAttempts: 5 });

    const result = await queue.ackFailure(WHATSAPP_INBOUND_QUEUE, 1, 2, payload(), 'boom');

    expect(result.deadLettered).toBe(false);
  });

  it('dead-letters and archives once maxAttempts is reached', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const from = vi.fn().mockReturnValue({ insert: vi.fn().mockResolvedValue({ error: null }) });
    const supabase = { rpc, from } as unknown as TypedSupabaseClient;
    const queue = new PgMqJobQueue(supabase, { maxAttempts: 3 });

    const result = await queue.ackFailure(WHATSAPP_INBOUND_QUEUE, 1, 3, payload(), 'boom', 'org-1');

    expect(result.deadLettered).toBe(true);
    expect(from).toHaveBeenCalledWith('failed_jobs');
    expect(rpc).toHaveBeenCalledWith('pgmq_archive', expect.objectContaining({ p_msg_id: 1 }));
  });
});
