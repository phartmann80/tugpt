import { metricsCollector } from '@tugpt/observability';
import type {
  AIProviderAdapter,
  ChatMessage,
  CompletionOptions,
  CompletionResponse,
} from './adapter';
import { isAbortError, ProviderAdapterError } from './provider-error';

export interface OpenAICompatibleAdapterConfig {
  readonly apiKey: string;
  readonly endpointUrl: string;
  readonly defaultModel: string;
  readonly fetchImpl?: typeof globalThis.fetch;
}

interface OpenAICompatibleResponse {
  readonly id?: string;
  readonly model?: string;
  readonly choices?: ReadonlyArray<{
    readonly message?: {
      readonly content?: string | null;
    };
  }>;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly total_tokens?: number;
  };
}

function nonNegativeTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

/** Shared hardened transport for providers implementing Chat Completions. */
export class OpenAICompatibleChatAdapter implements AIProviderAdapter {
  readonly providerName: string;
  private readonly apiKey: string;
  private readonly endpointUrl: string;
  private readonly defaultModel: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(providerName: string, config: OpenAICompatibleAdapterConfig) {
    this.providerName = providerName;
    this.apiKey = config.apiKey;
    this.endpointUrl = config.endpointUrl.replace(/\/+$/, '');
    this.defaultModel = config.defaultModel;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async generateCompletion(
    messages: readonly ChatMessage[],
    options: CompletionOptions = {}
  ): Promise<CompletionResponse> {
    const startedAt = Date.now();
    const requestedModel = options.model ?? this.defaultModel;

    try {
      const response = await this.fetchImpl(`${this.endpointUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: requestedModel,
          messages,
          temperature: options.temperature ?? 0.7,
          max_tokens: options.maxTokens ?? 1024,
          stream: false,
        }),
        signal: options.signal,
      });

      if (!response.ok) {
        throw new ProviderAdapterError({
          provider: this.providerName,
          code: 'http_error',
          status: response.status,
          message: `${this.providerName} request failed with HTTP ${response.status}`,
        });
      }

      let data: OpenAICompatibleResponse;
      try {
        data = (await response.json()) as OpenAICompatibleResponse;
      } catch (cause) {
        throw new ProviderAdapterError({
          provider: this.providerName,
          code: 'invalid_response',
          message: `${this.providerName} returned malformed JSON`,
          cause,
        });
      }

      const text = data.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || text.trim().length === 0) {
        throw new ProviderAdapterError({
          provider: this.providerName,
          code: 'invalid_response',
          message: `${this.providerName} returned no completion text`,
        });
      }

      const promptTokens = nonNegativeTokenCount(data.usage?.prompt_tokens);
      const completionTokens = nonNegativeTokenCount(data.usage?.completion_tokens);
      const reportedTotal = nonNegativeTokenCount(data.usage?.total_tokens);
      const totalTokens = reportedTotal || promptTokens + completionTokens;
      const latencyMs = Date.now() - startedAt;
      const model = data.model ?? requestedModel;

      metricsCollector.recordProviderCall({
        provider: this.providerName,
        model,
        promptTokens,
        completionTokens,
        totalTokens,
        latencyMs,
        success: true,
      });

      return {
        id: data.id ?? `${this.providerName}-${Date.now()}`,
        provider: this.providerName,
        model,
        text,
        usage: { promptTokens, completionTokens, totalTokens },
        latencyMs,
      };
    } catch (error) {
      const normalizedError =
        error instanceof ProviderAdapterError || isAbortError(error)
          ? error
          : new ProviderAdapterError({
              provider: this.providerName,
              code: 'network_error',
              message: `${this.providerName} transport failed`,
              cause: error,
            });

      metricsCollector.recordProviderCall({
        provider: this.providerName,
        model: requestedModel,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        latencyMs: Date.now() - startedAt,
        success: false,
        errorCode:
          normalizedError instanceof ProviderAdapterError
            ? normalizedError.status
              ? `${normalizedError.code}:${normalizedError.status}`
              : normalizedError.code
            : normalizedError instanceof Error
              ? normalizedError.name
              : 'unknown',
      });

      throw normalizedError;
    }
  }
}
