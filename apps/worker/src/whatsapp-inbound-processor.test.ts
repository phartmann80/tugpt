import { describe, expect, it, vi } from 'vitest';
import { processWhatsAppInboundJob } from './whatsapp-inbound-processor';
import type { WhatsAppInboundJobPayload } from '@tugpt/jobs';
import type { TypedSupabaseClient } from '@tugpt/database';

interface FakeReceipt {
  id: string;
  signature_verified: boolean;
  status: string;
  contact_wa_id: string | null;
  provider_event_id: string;
  body_text: string | null;
}

function createFakeSupabase(receipt: FakeReceipt) {
  const conversations = new Map<string, { id: string }>();
  const messages: Array<{ wa_message_id: string | null; whatsapp_connection_id: string }> = [];
  let conversationCounter = 0;
  let receiptStatus = receipt.status;

  const client = {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'webhook_events') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({ data: { ...receipt, status: receiptStatus }, error: null }),
          update: vi.fn().mockImplementation((patch: { status: string }) => {
            receiptStatus = patch.status;
            return { eq: vi.fn().mockResolvedValue({ error: null }) };
          }),
        };
      }
      if (table === 'conversations') {
        return {
          upsert: vi.fn().mockImplementation((row: { whatsapp_connection_id: string; contact_wa_id: string }) => {
            const key = `${row.whatsapp_connection_id}:${row.contact_wa_id}`;
            if (!conversations.has(key)) {
              conversationCounter += 1;
              conversations.set(key, { id: `conv-${conversationCounter}` });
            }
            const conv = conversations.get(key)!;
            return {
              select: vi.fn().mockReturnThis(),
              single: vi.fn().mockResolvedValue({ data: conv, error: null }),
            };
          }),
        };
      }
      if (table === 'messages') {
        return {
          insert: vi.fn().mockImplementation((row: { wa_message_id: string | null; whatsapp_connection_id: string }) => {
            const isDuplicate = messages.some(
              (m) => m.wa_message_id === row.wa_message_id && m.whatsapp_connection_id === row.whatsapp_connection_id
            );
            if (isDuplicate) {
              return Promise.resolve({ error: { code: '23505', message: 'duplicate key' } });
            }
            messages.push(row);
            return Promise.resolve({ error: null });
          }),
        };
      }
      return {};
    }),
  } as unknown as TypedSupabaseClient;

  return { client, messages, getReceiptStatus: () => receiptStatus };
}

function payload(overrides: Partial<WhatsAppInboundJobPayload> = {}): WhatsAppInboundJobPayload {
  return {
    organizationId: 'org-1',
    requestId: 'req-1',
    timestamp: new Date().toISOString(),
    webhookEventId: 'receipt-1',
    whatsappConnectionId: 'conn-1',
    ...overrides,
  };
}

describe('processWhatsAppInboundJob', () => {
  it('persists exactly one message and marks the receipt processed', async () => {
    const { client, messages, getReceiptStatus } = createFakeSupabase({
      id: 'receipt-1',
      signature_verified: true,
      status: 'received',
      contact_wa_id: 'contact-1',
      provider_event_id: 'wamid.1',
      body_text: 'hi',
    });

    await processWhatsAppInboundJob(client, payload());

    expect(messages).toHaveLength(1);
    expect(getReceiptStatus()).toBe('processed');
  });

  it('is idempotent under worker redelivery -- only one message exists after duplicate processing', async () => {
    const { client, messages } = createFakeSupabase({
      id: 'receipt-1',
      signature_verified: true,
      status: 'received',
      contact_wa_id: 'contact-1',
      provider_event_id: 'wamid.1',
      body_text: 'hi',
    });

    await processWhatsAppInboundJob(client, payload());
    // Simulate pgmq at-least-once redelivery of the same job.
    await processWhatsAppInboundJob(client, payload());

    expect(messages).toHaveLength(1);
  });

  it('is a no-op when the receipt was already marked processed by an earlier delivery', async () => {
    const { client, messages } = createFakeSupabase({
      id: 'receipt-1',
      signature_verified: true,
      status: 'processed',
      contact_wa_id: 'contact-1',
      provider_event_id: 'wamid.1',
      body_text: 'hi',
    });

    await processWhatsAppInboundJob(client, payload());

    expect(messages).toHaveLength(0);
  });

  it('refuses to process a receipt that is not signature-verified', async () => {
    const { client } = createFakeSupabase({
      id: 'receipt-1',
      signature_verified: false,
      status: 'received',
      contact_wa_id: 'contact-1',
      provider_event_id: 'wamid.1',
      body_text: 'hi',
    });

    await expect(processWhatsAppInboundJob(client, payload())).rejects.toThrow(/unverified/i);
  });
});
