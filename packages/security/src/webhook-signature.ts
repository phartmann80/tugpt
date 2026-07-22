import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies a Meta WhatsApp Cloud API webhook signature.
 *
 * Meta signs the raw request body with HMAC-SHA256 using the app secret and
 * sends the result in the `X-Hub-Signature-256` header as `sha256=<hex>`.
 * The signature MUST be verified against the exact raw body bytes -- never
 * against a re-serialized/parsed version of the JSON, since re-serialization
 * can change byte-for-byte formatting and invalidate the comparison.
 *
 * @param rawBody - The exact raw request body as received (string or Buffer).
 * @param signatureHeader - The full `X-Hub-Signature-256` header value.
 * @param appSecret - The WhatsApp app secret (never a raw value read from a
 *   database column directly in Phase 3A -- see SecretStore in a later
 *   slice; the caller is responsible for resolving the secret before
 *   calling this function).
 * @returns true if the signature is present, well-formed, and matches.
 */
export function verifyWhatsAppWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | null | undefined,
  appSecret: string
): boolean {
  if (!signatureHeader || !appSecret) {
    return false;
  }

  const prefix = 'sha256=';
  if (!signatureHeader.startsWith(prefix)) {
    return false;
  }

  const providedHex = signatureHeader.slice(prefix.length).trim();
  if (providedHex.length === 0) {
    return false;
  }

  const expectedHex = createHmac('sha256', appSecret).update(rawBody).digest('hex');

  // Lengths must match before timingSafeEqual (it throws on mismatched
  // buffer lengths); an unequal length is simply an invalid signature.
  if (providedHex.length !== expectedHex.length) {
    return false;
  }

  try {
    return timingSafeEqual(Buffer.from(providedHex, 'hex'), Buffer.from(expectedHex, 'hex'));
  } catch {
    // Buffer.from(..., 'hex') on a non-hex string produces a
    // shorter-than-expected buffer rather than throwing in Node, but guard
    // defensively in case that behavior differs across runtimes.
    return false;
  }
}

/**
 * Verifies the GET-based Meta webhook verification handshake.
 * See: https://developers.facebook.com/docs/graph-api/webhooks/getting-started
 */
export function verifyWhatsAppWebhookChallenge(
  mode: string | null,
  token: string | null,
  expectedVerifyToken: string
): boolean {
  return mode === 'subscribe' && !!token && token === expectedVerifyToken;
}
