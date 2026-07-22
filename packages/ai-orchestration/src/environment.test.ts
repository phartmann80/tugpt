import { InMemoryStore } from '@mastra/core/storage';
import { describe, expect, it } from 'vitest';
import { createAIOrchestrationFromEnv } from './environment';
import { AIOrchestrationError } from './errors';

describe('createAIOrchestrationFromEnv', () => {
  it('builds a Mastra runtime from explicit provider selection and storage', () => {
    const runtime = createAIOrchestrationFromEnv(
      {
        storage: new InMemoryStore({ id: 'environment-test' }),
        timeoutMs: 100,
      },
      {
        AI_TEXT_PRIMARY_PROVIDER: 'logicc',
        AI_TEXT_FALLBACK_PROVIDER: 'langdock',
        LOGICC_API_KEY: 'logicc-test-key',
        LANGDOCK_API_KEY: 'langdock-test-key',
        OPENAI_API_KEY: 'unused-openai-key',
      }
    );

    expect(runtime.selection).toEqual({
      primary: 'logicc',
      fallback: 'langdock',
    });
    expect(runtime.providers.listRegisteredProviders()).toEqual([
      'langdock',
      'logicc',
    ]);
    expect(runtime.mastra.getWorkflow('textCompletionWorkflow')).toBe(
      runtime.textCompletionWorkflow
    );
  });

  it('normalizes invalid startup selection without retaining its raw cause', () => {
    const error = (() => {
      try {
        createAIOrchestrationFromEnv(
          { storage: new InMemoryStore({ id: 'invalid-environment-test' }) },
          { AI_TEXT_PRIMARY_PROVIDER: 'mastra' }
        );
      } catch (cause) {
        return cause;
      }
      return undefined;
    })();

    expect(error).toBeInstanceOf(AIOrchestrationError);
    expect(error).toMatchObject({ code: 'no_provider_configured', attempts: [] });
    expect((error as AIOrchestrationError).cause).toBeUndefined();
  });
});
