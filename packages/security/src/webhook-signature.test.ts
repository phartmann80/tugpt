import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWhatsAppWebhookChallenge, verifyWhatsAppWebhookSignature } from './webhook-signature';

const APP_SECRET = 'test-app-secret';

function sign(body: string): string {
  return 'sha256=' + createHmac('sha256', APP_SECRET).update(body).digest('hex');
}

describe('verifyWhatsAppWebhookSignature', () => {
  it('accepts a correctly signed body', () => {
    const body = JSON.stringify({ hello: 'world' });
    expect(verifyWhatsAppWebhookSignature(body, sign(body), APP_SECRET)).toBe(true);
  });

  it('rejects a tampered body against the original signature', () => {
    const body = JSON.stringify({ hello: 'world' });
    const signature = sign(body);
    const tampered = JSON.stringify({ hello: 'WORLD' });
    expect(verifyWhatsAppWebhookSignature(tampered, signature, APP_SECRET)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    const body = JSON.stringify({ hello: 'world' });
    expect(verifyWhatsAppWebhookSignature(body, null, APP_SECRET)).toBe(false);
    expect(verifyWhatsAppWebhookSignature(body, undefined, APP_SECRET)).toBe(false);
  });

  it('rejects a signature missing the sha256= prefix', () => {
    const body = JSON.stringify({ hello: 'world' });
    const raw = createHmac('sha256', APP_SECRET).update(body).digest('hex');
    expect(verifyWhatsAppWebhookSignature(body, raw, APP_SECRET)).toBe(false);
  });

  it('rejects a signature signed with the wrong secret', () => {
    const body = JSON.stringify({ hello: 'world' });
    const wrongSignature = 'sha256=' + createHmac('sha256', 'wrong-secret').update(body).digest('hex');
    expect(verifyWhatsAppWebhookSignature(body, wrongSignature, APP_SECRET)).toBe(false);
  });
});

describe('verifyWhatsAppWebhookChallenge', () => {
  it('succeeds with the correct mode and verify token', () => {
    expect(verifyWhatsAppWebhookChallenge('subscribe', 'my-verify-token', 'my-verify-token')).toBe(true);
  });

  it('fails with an incorrect verify token', () => {
    expect(verifyWhatsAppWebhookChallenge('subscribe', 'wrong-token', 'my-verify-token')).toBe(false);
  });

  it('fails when hub.mode is not subscribe', () => {
    expect(verifyWhatsAppWebhookChallenge('unsubscribe', 'my-verify-token', 'my-verify-token')).toBe(false);
  });

  it('fails when the token is missing', () => {
    expect(verifyWhatsAppWebhookChallenge('subscribe', null, 'my-verify-token')).toBe(false);
  });
});
