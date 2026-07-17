export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  organizationId?: string;
  requestId?: string;
}

export interface CompletionResponse {
  id: string;
  provider: string;
  model: string;
  text: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  latencyMs: number;
}

export interface AIProviderAdapter {
  readonly providerName: string;
  generateCompletion(
    messages: ChatMessage[],
    options?: CompletionOptions
  ): Promise<CompletionResponse>;
}
