import { ProviderAdapterError } from '@tugpt/ai-providers';
import type {
  AIProviderAdapter,
  AIProviderFactory,
  ChatMessage,
  CompletionOptions,
  ProviderSelection,
  ProviderType,
} from '@tugpt/ai-providers';
import {
  AIOrchestrationError,
  CompletionTimeoutError,
  normalizeProviderError,
} from './errors';
import type {
  CompletionAttempt,
  RoutedCompletionOptions,
  RoutedCompletionResponse,
  RoutedCompletionResult,
} from './types';

export interface TextCompletionRouterOptions {
  readonly timeoutMs?: number;
}

export class TextCompletionRouter {
  private readonly timeoutMs: number;

  constructor(
    private readonly providers: AIProviderFactory,
    private readonly selection: ProviderSelection,
    options: TextCompletionRouterOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? 20_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('AI provider timeout must be a positive number');
    }
  }

  async complete(
    messages: readonly ChatMessage[],
    options: RoutedCompletionOptions = {}
  ): Promise<RoutedCompletionResult> {
    const attempts: CompletionAttempt[] = [];
    const primary = this.getConfiguredAdapter(this.selection.primary, attempts, 'primary');

    try {
      const response = await this.invokeProvider(
        this.selection.primary,
        primary,
        messages,
        options,
        attempts
      );
      return { response, attempts: [...attempts], usedFallback: false };
    } catch (error) {
      if (!(error instanceof AIOrchestrationError)) {
        throw error;
      }

      if (!this.selection.fallback || error.code === 'no_provider_configured') {
        throw error;
      }
    }

    const fallbackProvider = this.selection.fallback;
    const fallback = this.getConfiguredAdapter(fallbackProvider, attempts, 'fallback');
    const response = await this.invokeProvider(
      fallbackProvider,
      fallback,
      messages,
      options,
      attempts
    );
    return { response, attempts: [...attempts], usedFallback: true };
  }

  private getConfiguredAdapter(
    provider: ProviderType,
    attempts: readonly CompletionAttempt[],
    role: 'primary' | 'fallback'
  ): AIProviderAdapter {
    const adapter = this.providers.getOptionalAdapter(provider);
    if (!adapter) {
      throw new AIOrchestrationError(
        'no_provider_configured',
        `Explicitly selected ${role} provider '${provider}' is unavailable`,
        attempts
      );
    }
    return adapter;
  }

  private async invokeProvider(
    provider: ProviderType,
    adapter: AIProviderAdapter,
    messages: readonly ChatMessage[],
    options: RoutedCompletionOptions,
    attempts: CompletionAttempt[]
  ): Promise<RoutedCompletionResponse> {
    const startedAt = Date.now();
    const model = options.models?.[provider];

    try {
      const response = await this.callWithDeadline(adapter, messages, {
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        organizationId: options.organizationId,
        requestId: options.requestId,
        model,
      }, options.signal);

      if (response.provider !== provider) {
        throw new ProviderAdapterError({
          provider,
          code: 'invalid_response',
          message: `AI provider '${provider}' returned mismatched identity`,
        });
      }

      attempts.push({
        provider,
        model: response.model,
        outcome: 'success',
        latencyMs: response.latencyMs,
        usage: response.usage,
      });
      return { ...response, provider };
    } catch (cause) {
      const code = normalizeProviderError(cause);
      attempts.push({
        provider,
        model,
        outcome: 'failure',
        errorCode: code,
        latencyMs: Date.now() - startedAt,
      });
      throw new AIOrchestrationError(
        code,
        `AI provider '${provider}' failed with ${code}`,
        attempts
      );
    }
  }

  private async callWithDeadline(
    adapter: AIProviderAdapter,
    messages: readonly ChatMessage[],
    options: CompletionOptions,
    callerSignal?: AbortSignal
  ) {
    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let callerAbortHandler: (() => void) | undefined;

    const deadline = new Promise<never>((_, reject) => {
      const abort = (message: string) => {
        controller.abort();
        reject(new CompletionTimeoutError(message));
      };

      timeoutHandle = setTimeout(
        () => abort(`AI provider exceeded ${this.timeoutMs}ms timeout`),
        this.timeoutMs
      );

      if (callerSignal) {
        callerAbortHandler = () => abort('AI provider call was cancelled');
        if (callerSignal.aborted) {
          callerAbortHandler();
        } else {
          callerSignal.addEventListener('abort', callerAbortHandler, { once: true });
        }
      }
    });

    try {
      return await Promise.race([
        adapter.generateCompletion(messages, { ...options, signal: controller.signal }),
        deadline,
      ]);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (callerSignal && callerAbortHandler) {
        callerSignal.removeEventListener('abort', callerAbortHandler);
      }
    }
  }
}
