import {
  isAbortError,
  ProviderAdapterError,
} from '@tugpt/ai-providers';
import type {
  AIOrchestrationErrorCode,
  CompletionAttempt,
} from './types';

export class CompletionTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class AIOrchestrationError extends Error {
  readonly code: AIOrchestrationErrorCode;
  readonly attempts: readonly CompletionAttempt[];

  constructor(
    code: AIOrchestrationErrorCode,
    message: string,
    attempts: readonly CompletionAttempt[] = []
  ) {
    super(message);
    this.name = 'AIOrchestrationError';
    this.code = code;
    this.attempts = [...attempts];
  }
}

export function normalizeProviderError(error: unknown): AIOrchestrationErrorCode {
  if (isAbortError(error)) {
    return 'timeout';
  }

  if (error instanceof ProviderAdapterError) {
    if (error.status === 429) {
      return 'rate_limited';
    }
    if (error.code === 'invalid_response') {
      return 'invalid_response';
    }
  }

  return 'provider_error';
}
