import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

const APP_SECRET = 'test-app-secret';
const VERIFY_TOKEN = 'test-verify-token';

function sign(body: string): string {
  return 'sha256=' + createHmac('sha256', APP_SECRET).update(body).digest('hex');
}

const { mockEnqueue } = vi.hoisted(() => ({ mockEnqueue: vi.fn().mockResolvedValue({ jobId: '1' }) }));

vi.mock('@tugpt/jobs', () => ({
  PgMqJobQueue: vi.fn().mockImplementation(function PgMqJobQueue() {
    return { enqueue: mockEnqueue };
  }),
}));

type ConnectionRow = { id: string; organization_id: string };

let connectionRow: ConnectionRow | null;
let insertShouldConflict: boolean;
const insertedReceipts: unknown[] = [];

const mockAdminClient = {
  from: vi.fn().mockImplementation((table: string) => {
    if (table === 'whatsapp_connections') {
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: connectionRow, error: null }),
      };
    }
    if (table === 'webhook_events') {
      return {
        insert: vi.fn().mockImplementation((row: unknown) => {
          if (insertShouldConflict) {
            return {
              select: vi.fn().mockReturnThis(),
              single: vi.fn().mockResolvedValue({ data: null, error: { code: '23505', message: 'duplicate key' } }),
            };
          }
          insertedReceipts.push(row);
          return {
            select: vi.fn().mockReturnThis(),
            single: vi.fn().mockResolvedValue({ data: { id: `receipt-${insertedReceipts.length}` }, error: null }),
          };
        }),
      };
    }
    return {};
  }),
};

vi.mock('@tugpt/database', () => ({
  createAdminSupabaseClient: vi.fn(() => mockAdminClient),
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
              messages: [{ id: messageId, from: waId, type: 'text', text: { body: 'hello' } }],
            },
          },
        ],
      },
    ],
  });
}

describe('GET /api/v1/webhooks/whatsapp', () => {
  beforeEach(() => {
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = VERIFY_TOKEN;
    vi.resetModules();
  });

  it('succeeds with the correct verify token and echoes the challenge', async () => {
    const { GET } = await import('./route');
    const req = new Request(
      `http://localhost/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=echo-me`
    );
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('echo-me');
  });

  it('fails with an incorrect verify token', async () => {
    const { GET } = await import('./route');
    const req = new Request(
      'http://localhost/api/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=echo-me'
    );
    const res = await GET(req);
    expect(res.status).toBe(403);
  });
});

describe('POST /api/v1/webhooks/whatsapp', () => {
  beforeEach(() => {
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:56321';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
    connectionRow = { id: 'conn-1', organization_id: 'org-1' };
    insertShouldConflict = false;
    insertedReceipts.length = 0;
    mockEnqueue.mockClear();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 401 for an invalid signature', async () => {
    const { POST } = await import('./route');
    const body = messageEnvelope('wamid.1');
    const req = new Request('http://localhost/api/v1/webhooks/whatsapp', {
      method: 'POST',
      headers: { 'x-hub-signature-256': 'sha256=invalid' },
      body,
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(insertedReceipts).toHaveLength(0);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('creates exactly one receipt and one queue entry for a valid delivery', async () => {
    const { POST } = await import('./route');
    const body = messageEnvelope('wamid.1');
    const req = new Request('http://localhost/api/v1/webhooks/whatsapp', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign(body) },
      body,
    });
    const res = await POST(req);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.queued).toBe(1);
    expect(insertedReceipts).toHaveLength(1);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });

  it('produces no duplicate receipt or queue entry for a repeated delivery', async () => {
    const { POST } = await import('./route');
    const body = messageEnvelope('wamid.1');

    const req1 = new Request('http://localhost/api/v1/webhooks/whatsapp', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign(body) },
      body,
    });
    await POST(req1);

    insertShouldConflict = true;

    const req2 = new Request('http://localhost/api/v1/webhooks/whatsapp', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign(body) },
      body,
    });
    const res2 = await POST(req2);
    const json2 = await res2.json();

    expect(res2.status).toBe(200);
    expect(json2.duplicates).toBe(1);
    expect(json2.queued).toBe(0);
    expect(mockEnqueue).toHaveBeenCalledTimes(1); // only from the first delivery
  });

  it('normalizes multiple logical events in one envelope independently', async () => {
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

    const req = new Request('http://localhost/api/v1/webhooks/whatsapp', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign(body) },
      body,
    });
    const res = await POST(req);
    const json = await res.json();

    expect(json.queued).toBe(2);
    expect(insertedReceipts).toHaveLength(2);
    expect(mockEnqueue).toHaveBeenCalledTimes(2);
  });

  it('blocks writes for an event referencing an unknown connection (cross-tenant / unregistered number)', async () => {
    connectionRow = null;
    const { POST } = await import('./route');
    const body = messageEnvelope('wamid.1', 'unknown-phone-number-id');
    const req = new Request('http://localhost/api/v1/webhooks/whatsapp', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign(body) },
      body,
    });
    const res = await POST(req);
    const json = await res.json();

    expect(json.queued).toBe(0);
    expect(insertedReceipts).toHaveLength(0);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('never places message body or PII on the enqueued payload', async () => {
    const { POST } = await import('./route');
    const body = messageEnvelope('wamid.1');
    const req = new Request('http://localhost/api/v1/webhooks/whatsapp', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign(body) },
      body,
    });
    await POST(req);

    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const [, payload] = mockEnqueue.mock.calls[0];
    const keys = Object.keys(payload);

    expect(keys).toEqual(
      expect.arrayContaining(['organizationId', 'requestId', 'timestamp', 'webhookEventId', 'whatsappConnectionId'])
    );
    expect(JSON.stringify(payload)).not.toContain('hello'); // message body text
    expect(JSON.stringify(payload)).not.toContain('contact-1'); // WhatsApp contact ID (PII)
  });

  it('persists no raw webhook payload -- only normalized fields', async () => {
    const { POST } = await import('./route');
    const body = messageEnvelope('wamid.1');
    const req = new Request('http://localhost/api/v1/webhooks/whatsapp', {
      method: 'POST',
      headers: { 'x-hub-signature-256': sign(body) },
      body,
    });
    await POST(req);

    expect(insertedReceipts).toHaveLength(1);
    const receipt = insertedReceipts[0] as Record<string, unknown>;
    const keys = Object.keys(receipt);

    expect(keys).not.toContain('raw_payload');
    expect(keys).not.toContain('raw');
    expect(keys).not.toContain('entry');
  });
});
