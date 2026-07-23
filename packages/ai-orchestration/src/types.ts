import type {
  CompletionOptions,
  CompletionResponse,
  ProviderType,
} from '@tugpt/ai-providers';

export type AIOrchestrationErrorCode =
  | 'timeout'
  | 'rate_limited'
  | 'provider_error'
  | 'invalid_response'
  | 'no_provider_configured';

export interface CompletionAttempt {
  readonly provider: ProviderType;
  readonly model?: string;
  readonly outcome: 'success' | 'failure';
  readonly errorCode?: AIOrchestrationErrorCode;
  readonly latencyMs: number;
  readonly usage?: CompletionResponse['usage'];
}

export interface RoutedCompletionOptions
  extends Omit<CompletionOptions, 'model' | 'signal'> {
  readonly models?: Partial<Record<ProviderType, string>>;
  readonly signal?: AbortSignal;
}

export type RoutedCompletionResponse = Omit<CompletionResponse, 'provider'> & {
  readonly provider: ProviderType;
};

export interface RoutedCompletionResult {
  readonly response: RoutedCompletionResponse;
  readonly attempts: readonly CompletionAttempt[];
  readonly usedFallback: boolean;
}
