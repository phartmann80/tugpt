import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

const APP_SECRET = 'test-app-secret';
const VERIFY_TOKEN = 'test-verify-token';

function sign(body: string): string {
  return 'sha256=' + createHmac('sha256', APP_SECRET).update(body).digest('hex');
}

const { mockIngest, mockCreateAdmin } = vi.hoisted(() => ({
  mockIngest: vi.fn(),
  mockCreateAdmin: vi.fn(() => ({ rpc: vi.fn() })),
}));

vi.mock('@tugpt/jobs', () => ({
  PgMqJobQueue: vi.fn().mockImplementation(function PgMqJobQueue() {
    return { ingestWhatsAppMessageEvent: mockIngest };
  }),
}));

vi.mock('@tugpt/database', () => ({
  createAdminSupabaseClient: mockCreateAdmin,
}));

function messageEnvelope(messageId: string, phoneNumberId = 'pn-1', waId = 'contact-1'): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: phoneNumberId },
              messages: [{ id: messageId, from: waId, timestamp: '1700000000', type: 'text', text: { body: 'hello' } }],
            },
          },
        ],
      },
    ],
  });
}

function postRequest(body: string, signature = sign(body)): Request {
  return new Request('http://localhost/api/v1/webhooks/whatsapp', {
    method: 'POST',
    headers: { 'x-hub-signature-256': signature, 'x-request-id': 'req-test' },
    body,
  });
}

describe('GET /api/v1/webhooks/whatsapp', () => {
  beforeEach(() => {
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = VERIFY_TOKEN;
    vi.resetModules();
  });

  it('echoes the challenge for the correct verification token', async () => {
    const { GET } = await import('./route');
    const req = new Request(
      `http://localhost/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=echo-me`
    );

    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('echo-me');
  });

  it('rejects an incorrect verification token', async () => {
    const { GET } = await import('./route');
    const req = new Request(
      'http://localhost/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=echo-me'
    );

    expect((await GET(req)).status).toBe(403);
  });

  it('rejects a handshake with no challenge', async () => {
    const { GET } = await import('./route');
    const req = new Request(
      `http://localhost/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}`
    );

    expect((await GET(req)).status).toBe(403);
  });
});

describe('POST /api/v1/webhooks/whatsapp', () => {
  beforeEach(() => {
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:56321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    mockIngest.mockReset();
    mockIngest.mockResolvedValue({ outcome: 'queued', webhook_event_id: 'receipt-1', pgmq_msg_id: '1' });
    mockCreateAdmin.mockClear();
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 401 for an invalid signature without touching ingestion', async () => {
    const { POST } = await import('./route');
    const body = messageEnvelope('wamid.1');

    const res = await POST(postRequest(body, 'sha256=invalid'));

    expect(res.status).toBe(401);
    expect(mockIngest).not.toHaveBeenCalled();
    expect(mockCreateAdmin).not.toHaveBeenCalled();
  });

  it('calls one atomic ingestion operation for a valid delivery', async () => {
    const { POST } = await import('./route');
    const body = messageEnvelope('wamid.1');

    const res = await POST(postRequest(body));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ queued: 1, duplicates: 0, ignored: 0 });
    expect(mockIngest).toHaveBeenCalledTimes(1);
    expect(mockIngest).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      providerEventId: 'wamid.1',
      contactWaId: 'contact-1',
      messageType: 'text',
      body: 'hello',
      timestamp: '1700000000',
      requestId: 'req-test',
    });
  });

  it('does not pass the raw envelope to the atomic ingestion method', async () => {
    const { POST } = await import('./route');
    const body = messageEnvelope('wamid.1');

    await POST(postRequest(body));

    const input = mockIngest.mock.calls[0][0] as Record<string, unknown>;
    expect(input).not.toHaveProperty('raw');
    expect(input).not.toHaveProperty('rawBody');
    expect(input).not.toHaveProperty('entry');
    expect(JSON.stringify(input)).not.toContain('waba-1');
  });

  it('reports a database-detected replay as a duplicate without queueing again', async () => {
    mockIngest.mockResolvedValue({ outcome: 'duplicate', webhook_event_id: 'receipt-1', pgmq_msg_id: null });
    const { POST } = await import('./route');

    const res = await POST(postRequest(messageEnvelope('wamid.1')));

    expect(await res.json()).toMatchObject({ queued: 0, duplicates: 1, ignored: 0 });
    expect(mockIngest).toHaveBeenCalledTimes(1);
  });

  it('normalizes and ingests multiple logical events independently', async () => {
    mockIngest.mockImplementation(async (input: { providerEventId: string }) => ({
      outcome: input.providerEventId === 'wamid.2' ? 'duplicate' : 'queued',
      webhook_event_id: `receipt-${input.providerEventId}`,
      pgmq_msg_id: input.providerEventId === 'wamid.2' ? null : '1',
    }));
    const { POST } = await import('./route');
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba-1',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'pn-1' },
                messages: [
                  { id: 'wamid.1', from: 'contact-1', type: 'text', text: { body: 'a' } },
                  { id: 'wamid.2', from: 'contact-2', type: 'text', text: { body: 'b' } },
                ],
              },
            },
          ],
        },
      ],
    });

    const res = await POST(postRequest(body));

    expect(await res.json()).toMatchObject({ queued: 1, duplicates: 1, ignored: 0 });
    expect(mockIngest).toHaveBeenCalledTimes(2);
  });

  it('acknowledges an unregistered or inactive connection without writing a receipt', async () => {
    mockIngest.mockResolvedValue({ outcome: 'unknown_connection', webhook_event_id: null, pgmq_msg_id: null });
    const { POST } = await import('./route');

    const res = await POST(postRequest(messageEnvelope('wamid.1', 'unknown-phone-number-id')));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ queued: 0, duplicates: 0, ignored: 1 });
  });

  it('returns a retryable 503 when atomic ingestion fails', async () => {
    mockIngest.mockRejectedValue(new Error('pgmq unavailable'));
    const { POST } = await import('./route');

    const res = await POST(postRequest(messageEnvelope('wamid.1')));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Webhook ingestion temporarily unavailable' });
  });

  it('acknowledges a valid non-message webhook without opening the database', async () => {
    const { POST } = await import('./route');
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'message_template_status_update', value: {} }] }],
    });

    const res = await POST(postRequest(body));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, events: 0 });
    expect(mockCreateAdmin).not.toHaveBeenCalled();
  });
});
