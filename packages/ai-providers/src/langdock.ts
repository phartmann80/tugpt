import { metricsCollector } from '@tugpt/observability';
import type { AIProviderAdapter, ChatMessage, CompletionOptions, CompletionResponse } from './adapter';

export interface LangdockConfig {
  apiKey: string;
  endpointUrl?: string;
  defaultModel?: string;
}

export class LangdockAdapter implements AIProviderAdapter {
  readonly providerName = 'langdock';
  private apiKey: string;
  private endpointUrl: string;
  private defaultModel: string;

  constructor(config: LangdockConfig) {
    this.apiKey = config.apiKey;
    this.endpointUrl = config.endpointUrl || 'https://api.langdock.com/openai/eu/v1';
    this.defaultModel = config.defaultModel || 'gpt-5.2';
  }

  async generateCompletion(
    messages: ChatMessage[],
    options: CompletionOptions = {}
  ): Promise<CompletionResponse> {
    const startTime = Date.now();
    const model = options.model || this.defaultModel;

    const requestBody = {
      model,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 1024,
    };

    try {
      const response = await fetch(`${this.endpointUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        // Real cancellation per ADR-006 item 5 / ADR-011.
        signal: options.signal,
      });

      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        const errorText = await response.text();
        metricsCollector.recordProviderCall({
          provider: this.providerName,
          model,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          latencyMs,
          success: false,
          errorCode: `HTTP_${response.status}`,
        });
        throw new Error(`Langdock API Error (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as {
        id: string;
        choices: Array<{ message: { content: string } }>;
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };

      const text = data.choices[0]?.message?.content || '';
      const promptTokens = data.usage?.prompt_tokens || 0;
      const completionTokens = data.usage?.completion_tokens || 0;
      const totalTokens = data.usage?.total_tokens || promptTokens + completionTokens;

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
        id: data.id || `langdock-${Date.now()}`,
        provider: this.providerName,
        model,
        text,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens,
        },
        latencyMs,
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      metricsCollector.recordProviderCall({
        provider: this.providerName,
        model,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        latencyMs,
        success: false,
        errorCode: (err as Error).name || 'UNKNOWN',
      });
      throw err;
    }
  }
}
