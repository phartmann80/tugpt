import {
  AIProviderFactory,
  ProviderAdapterError,
  type AIProviderAdapter,
  type CompletionResponse,
} from '@tugpt/ai-providers';
import { InMemoryStore } from '@mastra/core/storage';
import { describe, expect, it, vi } from 'vitest';
import { TextCompletionRouter } from './router';
import { createAIOrchestrationRuntime } from './workflow';

function completion(provider: 'logicc' | 'langdock'): CompletionResponse {
  return {
    id: `${provider}-completion`,
    provider,
    model: `${provider}-model`,
    text: `response from ${provider}`,
    usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 },
    latencyMs: 9,
  };
}

describe('Mastra text-completion workflow', () => {
  it('registers and executes explicit fallback routing through Mastra', async () => {
    const primary: AIProviderAdapter = {
      providerName: 'logicc',
      generateCompletion: vi.fn().mockRejectedValue(
        new ProviderAdapterError({
          provider: 'logicc',
          code: 'http_error',
          status: 429,
          message: 'bounded rate limit',
        })
      ),
    };
    const fallback: AIProviderAdapter = {
      providerName: 'langdock',
      generateCompletion: vi.fn().mockResolvedValue(completion('langdock')),
    };
    const providers = new AIProviderFactory();
    providers.registerAdapter(primary);
    providers.registerAdapter(fallback);
    const router = new TextCompletionRouter(providers, {
      primary: 'logicc',
      fallback: 'langdock',
    });
    const { mastra, textCompletionWorkflow } = createAIOrchestrationRuntime(
      router,
      new InMemoryStore({ id: 'workflow-test' })
    );

    expect(mastra.getWorkflow('textCompletionWorkflow')).toBe(textCompletionWorkflow);

    const run = await textCompletionWorkflow.createRun();
    const result = await run.start({
      inputData: {
        messages: [{ role: 'user', content: 'Hola' }],
      },
    });

    expect(result.status).toBe('success');
    if (result.status !== 'success') {
      throw new Error(`Workflow failed with status ${result.status}`);
    }
    expect(result.result).toMatchObject({
      usedFallback: true,
      response: { provider: 'langdock', text: 'response from langdock' },
      attempts: [
        { provider: 'logicc', outcome: 'failure', errorCode: 'rate_limited' },
        { provider: 'langdock', outcome: 'success' },
      ],
    });
  });
});
