import { describe, expect, it, vi } from 'vitest';
import { processWhatsAppInboundJob } from './whatsapp-inbound-processor';
import type { WhatsAppInboundJobPayload } from '@tugpt/jobs';
import type { TypedSupabaseClient } from '@tugpt/database';

function payload(): WhatsAppInboundJobPayload {
  return {
    requestId: 'req-1',
    timestamp: '2026-01-01T00:00:00Z',
    webhookEventId: 'receipt-1',
  };
}

function clientWithRpc(data: unknown, error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  const from = vi.fn(() => {
    throw new Error('processor must not issue direct table queries');
  });
  return { client: { rpc, from } as unknown as TypedSupabaseClient, rpc, from };
}

describe('processWhatsAppInboundJob', () => {
  it('passes only the receipt ID to the atomic processing RPC', async () => {
    const { client, rpc, from } = clientWithRpc({
      outcome: 'processed',
      conversation_id: 'conversation-1',
      message_created: true,
    });

    await expect(processWhatsAppInboundJob(client, payload())).resolves.toBe('processed');

    expect(rpc).toHaveBeenCalledWith('process_whatsapp_inbound_receipt', {
      p_webhook_event_id: 'receipt-1',
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('ignores forged tenant fields if a hostile queue payload contains extras', async () => {
    const { client, rpc } = clientWithRpc({ outcome: 'processed' });
    const hostilePayload = {
      ...payload(),
      organizationId: 'forged-org',
      whatsappConnectionId: 'forged-connection',
      body: 'forged body',
    } as WhatsAppInboundJobPayload;

    await processWhatsAppInboundJob(client, hostilePayload);

    const args = rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(args).toEqual({ p_webhook_event_id: 'receipt-1' });
    expect(args).not.toHaveProperty('organizationId');
    expect(args).not.toHaveProperty('whatsappConnectionId');
    expect(args).not.toHaveProperty('body');
  });

  it('treats an already-processed receipt as an idempotent success', async () => {
    const { client } = clientWithRpc({ outcome: 'already_processed' });

    await expect(processWhatsAppInboundJob(client, payload())).resolves.toBe('already_processed');
  });

  it('propagates RPC failures to the worker retry/dead-letter path', async () => {
    const { client } = clientWithRpc(null, { message: 'staging row missing' });

    await expect(processWhatsAppInboundJob(client, payload())).rejects.toThrow(/staging row missing/);
  });

  it('rejects an unknown RPC result instead of acknowledging the job', async () => {
    const { client } = clientWithRpc({ outcome: 'unexpected' });

    await expect(processWhatsAppInboundJob(client, payload())).rejects.toThrow(/unknown outcome/);
  });

  it('rejects a payload with no receipt ID before calling the database', async () => {
    const { client, rpc } = clientWithRpc({ outcome: 'processed' });

    await expect(
      processWhatsAppInboundJob(client, { timestamp: '2026-01-01T00:00:00Z' } as WhatsAppInboundJobPayload)
    ).rejects.toThrow(/missing webhookEventId/);
    expect(rpc).not.toHaveBeenCalled();
  });
});
