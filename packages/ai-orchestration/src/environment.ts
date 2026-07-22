import {
  AIProviderFactory,
  ProviderSelectionError,
  type ProviderEnvironment,
} from '@tugpt/ai-providers';
import type { MastraCompositeStore } from '@mastra/core/storage';
import { AIOrchestrationError } from './errors';
import {
  TextCompletionRouter,
  type TextCompletionRouterOptions,
} from './router';
import { createAIOrchestrationRuntime } from './workflow';

export interface AIOrchestrationEnvironmentOptions
  extends TextCompletionRouterOptions {
  readonly storage: MastraCompositeStore;
}

export function createAIOrchestrationFromEnv(
  options: AIOrchestrationEnvironmentOptions,
  environment: ProviderEnvironment = process.env
) {
  const providers = new AIProviderFactory();

  try {
    const selection = providers.initializeFromEnv(environment);
    const router = new TextCompletionRouter(providers, selection, {
      timeoutMs: options.timeoutMs,
    });
    return {
      providers,
      selection,
      router,
      ...createAIOrchestrationRuntime(router, options.storage),
    };
  } catch (cause) {
    if (cause instanceof ProviderSelectionError) {
      throw new AIOrchestrationError(
        'no_provider_configured',
        'AI text provider selection is invalid',
        []
      );
    }
    throw cause;
  }
}
