import type { AIProviderAdapter } from './adapter';
import { LangdockAdapter } from './langdock';
import { LogiccAdapter } from './logicc';
import { OpenAIAdapter } from './openai';

export type ProviderType = 'logicc' | 'langdock' | 'openai';
export type ProviderEnvironment = Readonly<Record<string, string | undefined>>;

export interface ProviderSelection {
  readonly primary: ProviderType;
  readonly fallback?: ProviderType;
}

const PROVIDER_TYPES = new Set<ProviderType>(['logicc', 'langdock', 'openai']);

export class ProviderSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderSelectionError';
  }
}

function parseProvider(value: string | undefined, variableName: string): ProviderType {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || !PROVIDER_TYPES.has(normalized as ProviderType)) {
    throw new ProviderSelectionError(
      `${variableName} must explicitly name one of: ${[...PROVIDER_TYPES].join(', ')}`
    );
  }
  return normalized as ProviderType;
}

export function parseProviderSelection(environment: ProviderEnvironment): ProviderSelection {
  const primary = parseProvider(
    environment.AI_TEXT_PRIMARY_PROVIDER,
    'AI_TEXT_PRIMARY_PROVIDER'
  );
  const fallbackValue = environment.AI_TEXT_FALLBACK_PROVIDER?.trim();
  const fallback = fallbackValue
    ? parseProvider(fallbackValue, 'AI_TEXT_FALLBACK_PROVIDER')
    : undefined;

  if (fallback === primary) {
    throw new ProviderSelectionError('AI text primary and fallback providers must be different');
  }

  return { primary, fallback };
}

function createAdapter(
  provider: ProviderType,
  environment: ProviderEnvironment
): AIProviderAdapter | undefined {
  switch (provider) {
    case 'logicc': {
      const apiKey = environment.LOGICC_API_KEY;
      return apiKey
        ? new LogiccAdapter({
            apiKey,
            endpointUrl: environment.LOGICC_ENDPOINT_URL,
            defaultModel: environment.LOGICC_MODEL,
          })
        : undefined;
    }
    case 'langdock': {
      const apiKey = environment.LANGDOCK_API_KEY ?? environment.LANGDOCK_API_CODE;
      return apiKey
        ? new LangdockAdapter({
            apiKey,
            endpointUrl: environment.LANGDOCK_ENDPOINT_URL,
            defaultModel: environment.LANGDOCK_MODEL ?? environment.MODEL,
          })
        : undefined;
    }
    case 'openai': {
      const apiKey = environment.OPENAI_API_KEY;
      return apiKey
        ? new OpenAIAdapter({
            apiKey,
            baseUrl: environment.OPENAI_BASE_URL,
            defaultModel: environment.OPENAI_MODEL,
          })
        : undefined;
    }
  }
}

export class AIProviderFactory {
  private static instance: AIProviderFactory;
  private readonly adapters = new Map<string, AIProviderAdapter>();

  public static getInstance(): AIProviderFactory {
    if (!AIProviderFactory.instance) {
      AIProviderFactory.instance = new AIProviderFactory();
    }
    return AIProviderFactory.instance;
  }

  public registerAdapter(adapter: AIProviderAdapter): void {
    this.adapters.set(adapter.providerName.toLowerCase(), adapter);
  }

  public clear(): void {
    this.adapters.clear();
  }

  public hasAdapter(providerName: ProviderType | string): boolean {
    return this.adapters.has(providerName.toLowerCase());
  }

  public getOptionalAdapter(providerName: ProviderType | string): AIProviderAdapter | undefined {
    return this.adapters.get(providerName.toLowerCase());
  }

  public getAdapter(providerName: ProviderType | string): AIProviderAdapter {
    const adapter = this.getOptionalAdapter(providerName);
    if (!adapter) {
      throw new Error(`AI Provider Adapter '${providerName}' is not registered.`);
    }
    return adapter;
  }

  public listRegisteredProviders(): readonly string[] {
    return [...this.adapters.keys()].sort();
  }

  /**
   * Registers only the explicitly selected providers.
   *
   * Credentials for unnamed providers are intentionally ignored. A selected
   * provider with a missing credential remains unregistered so orchestration
   * can fail closed with `no_provider_configured`.
   */
  public initializeFromEnv(environment: ProviderEnvironment = process.env): ProviderSelection {
    this.clear();
    const selection = parseProviderSelection(environment);
    const selectedProviders: ProviderType[] = [selection.primary];
    if (selection.fallback) {
      selectedProviders.push(selection.fallback);
    }

    for (const provider of selectedProviders) {
      const adapter = createAdapter(provider, environment);
      if (adapter) {
        this.registerAdapter(adapter);
      }
    }

    return selection;
  }
}

export const aiProviderFactory = AIProviderFactory.getInstance();
