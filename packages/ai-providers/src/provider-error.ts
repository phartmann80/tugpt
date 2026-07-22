export type ProviderAdapterErrorCode = 'http_error' | 'invalid_response' | 'network_error';

export interface ProviderAdapterErrorOptions {
  readonly provider: string;
  readonly code: ProviderAdapterErrorCode;
  readonly message: string;
  readonly status?: number;
  readonly cause?: unknown;
}

/**
 * Bounded, provider-neutral transport failure.
 *
 * Provider response bodies are deliberately excluded: they can echo customer
 * content or vendor diagnostics and must not cross the adapter boundary.
 */
export class ProviderAdapterError extends Error {
  readonly provider: string;
  readonly code: ProviderAdapterErrorCode;
  readonly status?: number;

  constructor(options: ProviderAdapterErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = 'ProviderAdapterError';
    this.provider = options.provider;
    this.code = options.code;
    this.status = options.status;
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}
