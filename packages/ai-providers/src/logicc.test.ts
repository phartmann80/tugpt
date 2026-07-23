import { metricsCollector } from '@tugpt/observability';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogiccAdapter } from './logicc';
import { ProviderAdapterError } from './provider-error';

const messages = [{ role: 'user' as const, content: 'Hola' }];

describe('LogiccAdapter', () => {
  beforeEach(() => {
    metricsCollector.clear();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the documented OpenAI-compatible chat-completions contract', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'completion-1',
          model: 'gpt-5-nano',
          choices: [{ message: { content: 'Hola, ¿en qué puedo ayudarte?' } }],
          usage: {
            prompt_tokens: 8,
            completion_tokens: 11,
            total_tokens: 19,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    const controller = new AbortController();
    const adapter = new LogiccAdapter({
      apiKey: 'test-logicc-key',
      fetchImpl: fetchImpl as typeof fetch,
    });

    const result = await adapter.generateCompletion(messages, {
      temperature: 0.2,
      maxTokens: 200,
      signal: controller.signal,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.logicc.io/v1/chat/completions');
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-logicc-key',
      },
      signal: controller.signal,
    });
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'gpt-5-nano',
      messages,
      temperature: 0.2,
      max_tokens: 200,
      stream: false,
    });
    expect(result).toMatchObject({
      id: 'completion-1',
      provider: 'logicc',
      model: 'gpt-5-nano',
      text: 'Hola, ¿en qué puedo ayudarte?',
      usage: { promptTokens: 8, completionTokens: 11, totalTokens: 19 },
    });
    expect(metricsCollector.getRecentMetrics()).toHaveLength(1);
    expect(metricsCollector.getRecentMetrics()[0]).toMatchObject({
      provider: 'logicc',
      success: true,
      totalTokens: 19,
    });
  });

  it('normalizes rate limits without reading or exposing the provider body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('provider diagnostic containing customer-secret-text', {
        status: 429,
      })
    );
    const adapter = new LogiccAdapter({
      apiKey: 'test-logicc-key',
      fetchImpl: fetchImpl as typeof fetch,
    });

    const error = await adapter.generateCompletion(messages).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ProviderAdapterError);
    expect(error).toMatchObject({
      provider: 'logicc',
      code: 'http_error',
      status: 429,
    });
    expect(String(error)).not.toContain('customer-secret-text');
    expect(console.log).not.toHaveBeenCalledWith(
      expect.stringContaining('customer-secret-text')
    );
    expect(metricsCollector.getRecentMetrics()).toHaveLength(1);
  });

  it.each([
    ['malformed JSON', new Response('not-json', { status: 200 })],
    [
      'missing completion text',
      new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ],
  ])('rejects %s as a bounded invalid response', async (_label, response) => {
    const adapter = new LogiccAdapter({
      apiKey: 'test-logicc-key',
      fetchImpl: vi.fn().mockResolvedValue(response) as typeof fetch,
    });

    await expect(adapter.generateCompletion(messages)).rejects.toMatchObject({
      provider: 'logicc',
      code: 'invalid_response',
    });
    expect(metricsCollector.getRecentMetrics()).toHaveLength(1);
  });
});
