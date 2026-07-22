import { metricsCollector } from '@tugpt/observability';
import type { AIProviderAdapter, ChatMessage, CompletionOptions, CompletionResponse } from './adapter';

export interface MastraConfig {
  apiKey: string;
  gatewayUrl?: string;
  defaultAgent?: string;
}

export class MastraAdapter implements AIProviderAdapter {
  readonly providerName = 'mastra';
  private apiKey: string;
  private gatewayUrl: string;
  private defaultAgent: string;

  constructor(config: MastraConfig) {
    this.apiKey = config.apiKey;
    this.gatewayUrl = config.gatewayUrl || 'https://gateway-api.mastra.ai';
    this.defaultAgent = config.defaultAgent || 'default-assistant';
  }

  async generateCompletion(
    messages: ChatMessage[],
    options: CompletionOptions = {}
  ): Promise<CompletionResponse> {
    const startTime = Date.now();
    const agentName = options.model || this.defaultAgent;

    const requestBody = {
      agent: agentName,
      messages,
      context: {
        organizationId: options.organizationId,
        requestId: options.requestId,
      },
    };

    try {
      const response = await fetch(`${this.gatewayUrl}/v1/agents/${agentName}/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Mastra-Api-Key': this.apiKey,
        },
        body: JSON.stringify(requestBody),
        // Real cancellation per ADR-006 item 5 / ADR-011. Note: per ADR-011,
        // this class is legacy under the new model (Mastra is the
        // orchestration runtime, not an adapter peer) and is not renamed or
        // repurposed as part of Phase 3A.
        signal: options.signal,
      });

      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        const errorText = await response.text();
        metricsCollector.recordProviderCall({
          provider: this.providerName,
          model: agentName,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          latencyMs,
          success: false,
          errorCode: `HTTP_${response.status}`,
        });
        throw new Error(`Mastra API Error (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as {
        id?: string;
        text?: string;
        response?: string;
        usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
      };

      const text = data.text || data.response || '';
      const promptTokens = data.usage?.promptTokens || 0;
      const completionTokens = data.usage?.completionTokens || 0;
      const totalTokens = data.usage?.totalTokens || promptTokens + completionTokens;

      metricsCollector.recordProviderCall({
        provider: this.providerName,
        model: agentName,
        promptTokens,
        completionTokens,
        totalTokens,
        latencyMs,
        success: true,
      });

      return {
        id: data.id || `mastra-${Date.now()}`,
        provider: this.providerName,
        model: agentName,
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
        model: agentName,
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
