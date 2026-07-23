import {
  AIProviderFactory,
  ProviderAdapterError,
  type AIProviderAdapter,
  type CompletionOptions,
  type CompletionResponse,
  type ProviderType,
} from '@tugpt/ai-providers';
import { describe, expect, it, vi } from 'vitest';
import { AIOrchestrationError } from './errors';
import { TextCompletionRouter } from './router';

const messages = [{ role: 'user' as const, content: 'Hola' }];

function response(provider: ProviderType, model = `${provider}-model`): CompletionResponse {
  return {
    id: `${provider}-completion`,
    provider,
    model,
    text: `response from ${provider}`,
    usage: { promptTokens: 4, completionTokens: 6, totalTokens: 10 },
    latencyMs: 12,
  };
}

function adapter(
  providerName: ProviderType,
  implementation: (
    options: CompletionOptions
  ) => Promise<CompletionResponse>
): AIProviderAdapter & { generateCompletion: ReturnType<typeof vi.fn> } {
  return {
    providerName,
    generateCompletion: vi.fn((_messages, options = {}) => implementation(options)),
  };
}

function providers(...adapters: AIProviderAdapter[]): AIProviderFactory {
  const factory = new AIProviderFactory();
  for (const registered of adapters) {
    factory.registerAdapter(registered);
  }
  return factory;
}

describe('TextCompletionRouter', () => {
  it('returns the primary result without touching fallback', async () => {
    const primary = adapter('logicc', async () => response('logicc'));
    const fallback = adapter('langdock', async () => response('langdock'));
    const router = new TextCompletionRouter(providers(primary, fallback), {
      primary: 'logicc',
      fallback: 'langdock',
    });

    const result = await router.complete(messages);

    expect(result.response.provider).toBe('logicc');
    expect(result.usedFallback).toBe(false);
    expect(result.attempts).toEqual([
      expect.objectContaining({ provider: 'logicc', outcome: 'success' }),
    ]);
    expect(primary.generateCompletion).toHaveBeenCalledOnce();
    expect(fallback.generateCompletion).not.toHaveBeenCalled();
  });

  it('uses only the explicitly selected fallback after a primary rate limit', async () => {
    const primary = adapter('logicc', async () => {
      throw new ProviderAdapterError({
        provider: 'logicc',
        code: 'http_error',
        status: 429,
        message: 'bounded rate limit',
      });
    });
    const fallback = adapter('langdock', async (options) =>
      response('langdock', options.model)
    );
    const router = new TextCompletionRouter(providers(primary, fallback), {
      primary: 'logicc',
      fallback: 'langdock',
    });

    const result = await router.complete(messages, {
      models: { logicc: 'logicc-model', langdock: 'langdock-model' },
    });

    expect(result.response).toMatchObject({
      provider: 'langdock',
      model: 'langdock-model',
    });
    expect(result.usedFallback).toBe(true);
    expect(result.attempts).toEqual([
      expect.objectContaining({
        provider: 'logicc',
        model: 'logicc-model',
        outcome: 'failure',
        errorCode: 'rate_limited',
      }),
      expect.objectContaining({
        provider: 'langdock',
        model: 'langdock-model',
        outcome: 'success',
      }),
    ]);
  });

  it('fails closed without invoking fallback when the selected primary is unavailable', async () => {
    const fallback = adapter('langdock', async () => response('langdock'));
    const router = new TextCompletionRouter(providers(fallback), {
      primary: 'logicc',
      fallback: 'langdock',
    });

    const error = await router.complete(messages).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AIOrchestrationError);
    expect(error).toMatchObject({ code: 'no_provider_configured', attempts: [] });
    expect(fallback.generateCompletion).not.toHaveBeenCalled();
  });

  it('aborts a timed-out primary transport before using fallback', async () => {
    let primaryWasAborted = false;
    const primary = adapter(
      'logicc',
      (options) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => {
              primaryWasAborted = true;
              reject(new DOMException('aborted', 'AbortError'));
            },
            { once: true }
          );
        })
    );
    const fallback = adapter('langdock', async () => response('langdock'));
    const router = new TextCompletionRouter(
      providers(primary, fallback),
      { primary: 'logicc', fallback: 'langdock' },
      { timeoutMs: 5 }
    );

    const result = await router.complete(messages);

    expect(primaryWasAborted).toBe(true);
    expect(result.usedFallback).toBe(true);
    expect(result.attempts[0]).toMatchObject({
      provider: 'logicc',
      outcome: 'failure',
      errorCode: 'timeout',
    });
  });

  it('rejects a mismatched adapter identity as an invalid response', async () => {
    const primary = adapter('logicc', async () => response('langdock'));
    const fallback = adapter('langdock', async () => response('langdock'));
    const router = new TextCompletionRouter(providers(primary, fallback), {
      primary: 'logicc',
      fallback: 'langdock',
    });

    const result = await router.complete(messages);

    expect(result.usedFallback).toBe(true);
    expect(result.attempts[0]).toMatchObject({
      provider: 'logicc',
      outcome: 'failure',
      errorCode: 'invalid_response',
    });
  });

  it('normalizes the final failure and preserves both bounded attempts', async () => {
    const primary = adapter('logicc', async () => {
      throw new Error('transport down');
    });
    const fallback = adapter('langdock', async () => {
      throw new ProviderAdapterError({
        provider: 'langdock',
        code: 'invalid_response',
        message: 'bounded invalid response',
      });
    });
    const router = new TextCompletionRouter(providers(primary, fallback), {
      primary: 'logicc',
      fallback: 'langdock',
    });

    const error = await router.complete(messages).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AIOrchestrationError);
    expect(error).toMatchObject({ code: 'invalid_response' });
    expect((error as AIOrchestrationError).cause).toBeUndefined();
    expect((error as AIOrchestrationError).attempts).toEqual([
      expect.objectContaining({ provider: 'logicc', errorCode: 'provider_error' }),
      expect.objectContaining({ provider: 'langdock', errorCode: 'invalid_response' }),
    ]);
  });
});
