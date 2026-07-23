import {
  OpenAICompatibleChatAdapter,
  type OpenAICompatibleAdapterConfig,
} from './openai-compatible';

export interface OpenAIConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly defaultModel?: string;
  readonly fetchImpl?: OpenAICompatibleAdapterConfig['fetchImpl'];
}

export class OpenAIAdapter extends OpenAICompatibleChatAdapter {
  constructor(config: OpenAIConfig) {
    super('openai', {
      apiKey: config.apiKey,
      endpointUrl: config.baseUrl ?? 'https://api.openai.com/v1',
      defaultModel: config.defaultModel ?? 'gpt-4o',
      fetchImpl: config.fetchImpl,
    });
  }
}
