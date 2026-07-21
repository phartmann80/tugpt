import { describe, expect, it } from 'vitest';
import { normalizeWhatsAppWebhookEnvelope } from './normalize-webhook-envelope';

function envelope(entries: unknown[]): string {
  return JSON.stringify({ object: 'whatsapp_business_account', entry: entries });
}

describe('normalizeWhatsAppWebhookEnvelope', () => {
  it('normalizes a single message into one logical event', () => {
    const raw = envelope([
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'pn-1', display_phone_number: '+491234567' },
              contacts: [{ wa_id: 'contact-1' }],
              messages: [{ id: 'wamid.1', from: 'contact-1', timestamp: '1700000000', type: 'text', text: { body: 'hi' } }],
            },
          },
        ],
      },
    ]);

    const events = normalizeWhatsAppWebhookEnvelope(raw);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      providerEventId: 'wamid.1',
      phoneNumberId: 'pn-1',
      contactWaId: 'contact-1',
      messageType: 'text',
      body: 'hi',
    });
  });

  it('normalizes multiple logical events from one envelope independently', () => {
    const raw = envelope([
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'pn-1' },
              messages: [
                { id: 'wamid.1', from: 'contact-1', type: 'text', text: { body: 'first' } },
                { id: 'wamid.2', from: 'contact-2', type: 'text', text: { body: 'second' } },
              ],
            },
          },
        ],
      },
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'pn-2' },
              messages: [{ id: 'wamid.3', from: 'contact-3', type: 'text', text: { body: 'third' } }],
            },
          },
        ],
      },
    ]);

    const events = normalizeWhatsAppWebhookEnvelope(raw);

    expect(events).toHaveLength(3);
    expect(events.map((e) => e.providerEventId)).toEqual(['wamid.1', 'wamid.2', 'wamid.3']);
    expect(events.map((e) => e.body)).toEqual(['first', 'second', 'third']);
  });

  it('skips a malformed message without discarding well-formed siblings', () => {
    const raw = envelope([
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'pn-1' },
              messages: [
                { id: 'wamid.1', from: 'contact-1', type: 'text', text: { body: 'ok' } },
                { from: 'contact-2', type: 'text', text: { body: 'missing id, skipped' } },
              ],
            },
          },
        ],
      },
    ]);

    const events = normalizeWhatsAppWebhookEnvelope(raw);

    expect(events).toHaveLength(1);
    expect(events[0].providerEventId).toBe('wamid.1');
  });

  it('ignores non-message change events (e.g. status callbacks)', () => {
    const raw = envelope([
      {
        id: 'waba-1',
        changes: [{ field: 'message_template_status_update', value: {} }],
      },
    ]);

    expect(normalizeWhatsAppWebhookEnvelope(raw)).toEqual([]);
  });

  it('returns an empty array for malformed JSON', () => {
    expect(normalizeWhatsAppWebhookEnvelope('not json')).toEqual([]);
  });

  it('returns an empty array when entry is missing', () => {
    expect(normalizeWhatsAppWebhookEnvelope(JSON.stringify({ object: 'whatsapp_business_account' }))).toEqual([]);
  });

  it('never retains the raw envelope on the normalized event shape', () => {
    const raw = envelope([
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'pn-1' },
              messages: [{ id: 'wamid.1', from: 'contact-1', type: 'text', text: { body: 'hi' } }],
            },
          },
        ],
      },
    ]);

    const events = normalizeWhatsAppWebhookEnvelope(raw);
    const keys = Object.keys(events[0]);

    expect(keys).toEqual(
      expect.arrayContaining(['providerEventId', 'phoneNumberId', 'displayPhoneNumber', 'contactWaId', 'messageType', 'body', 'timestamp'])
    );
    expect(keys).not.toContain('raw');
    expect(keys).not.toContain('entry');
  });
});
