/**
 * Normalizes a raw WhatsApp Cloud API webhook envelope into a flat list of
 * logical events. One HTTP POST can contain multiple `entry[]`, each with
 * multiple `changes[]`, each with multiple `value.messages[]` -- Meta
 * batches deliveries. Each logical event is normalized and processed
 * independently: one malformed message inside a batch must not prevent the
 * other, well-formed messages in the same envelope from being persisted.
 *
 * This module intentionally extracts the SMALLEST possible set of fields
 * needed to create a webhook_events receipt and, downstream, a message row.
 * It does not retain the raw envelope -- callers must not persist the
 * envelope itself, only the normalized event shape below (Phase 3A
 * requirement: no raw webhook payload persisted).
 */

export interface NormalizedWhatsAppEvent {
  /** Meta's own message ID -- the idempotency key for webhook_events and messages. */
  providerEventId: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  contactWaId: string;
  /** Present only long enough to compute a conversation key -- never persisted verbatim into webhook_events. */
  messageType: string;
  /** Message body text, if any. Carried only as far as message persistence in apps/worker -- never placed on the queue. */
  body: string | null;
  timestamp: string | null;
}

interface RawWhatsAppValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: Array<{ wa_id?: string }>;
  messages?: Array<{
    id?: string;
    from?: string;
    timestamp?: string;
    type?: string;
    text?: { body?: string };
  }>;
}

interface RawWhatsAppChange {
  field?: string;
  value?: RawWhatsAppValue;
}

interface RawWhatsAppEntry {
  id?: string;
  changes?: RawWhatsAppChange[];
}

interface RawWhatsAppEnvelope {
  object?: string;
  entry?: RawWhatsAppEntry[];
}

/**
 * Parses and normalizes one webhook envelope. Malformed entries/changes/
 * messages are skipped individually (not fatal to the whole envelope) --
 * each logical event is normalized independently, per the Phase 3A
 * requirement.
 */
export function normalizeWhatsAppWebhookEnvelope(rawBody: string): NormalizedWhatsAppEvent[] {
  let envelope: RawWhatsAppEnvelope;
  try {
    envelope = JSON.parse(rawBody) as RawWhatsAppEnvelope;
  } catch {
    return [];
  }

  if (!envelope || !Array.isArray(envelope.entry)) {
    return [];
  }

  const events: NormalizedWhatsAppEvent[] = [];

  for (const entry of envelope.entry) {
    if (!entry || !Array.isArray(entry.changes)) continue;

    for (const change of entry.changes) {
      if (!change || change.field !== 'messages' || !change.value) continue;

      const value = change.value;
      const phoneNumberId = value.metadata?.phone_number_id;
      const displayPhoneNumber = value.metadata?.display_phone_number ?? null;

      if (!phoneNumberId || !Array.isArray(value.messages)) continue;

      for (const message of value.messages) {
        if (!message || !message.id || !message.from) continue;

        events.push({
          providerEventId: message.id,
          phoneNumberId,
          displayPhoneNumber,
          contactWaId: message.from,
          messageType: message.type ?? 'unknown',
          body: message.type === 'text' ? message.text?.body ?? null : null,
          timestamp: message.timestamp ?? null,
        });
      }
    }
  }

  return events;
}
