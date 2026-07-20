/**
 * @file adapter.ts
 * @description Unified AI Provider Adapter Contract for TuGPT.ai.
 * 
 * CRITICAL SECURITY & STABILITY WARNING:
 * This contract represents the frozen interface for all AI provider adapters
 * (OpenAI, Langdock, Mastra). Do NOT modify or append to this contract without
 * a formal architectural review and approved RFC.
 */

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface CompletionOptions {
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly organizationId?: string;
  readonly requestId?: string;
}

export interface CompletionResponse {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly text: string;
  readonly usage: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
  readonly latencyMs: number;
}

export interface AIProviderAdapter {
  readonly providerName: string;
  
  /**
   * Generates a text completion based on standard ChatMessages.
   * Locked to prevent contract shifts before Phase 3 authorization.
   */
  generateCompletion(
    messages: readonly ChatMessage[],
    options?: CompletionOptions
  ): Promise<CompletionResponse>;
}
