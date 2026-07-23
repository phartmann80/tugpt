import {
  OpenAICompatibleChatAdapter,
  type OpenAICompatibleAdapterConfig,
} from './openai-compatible';

export interface LangdockConfig {
  readonly apiKey: string;
  readonly endpointUrl?: string;
  readonly defaultModel?: string;
  readonly fetchImpl?: OpenAICompatibleAdapterConfig['fetchImpl'];
}

export class LangdockAdapter extends OpenAICompatibleChatAdapter {
  constructor(config: LangdockConfig) {
    super('langdock', {
      apiKey: config.apiKey,
      endpointUrl: config.endpointUrl ?? 'https://api.langdock.com/openai/eu/v1',
      defaultModel: config.defaultModel ?? 'gpt-5.2',
      fetchImpl: config.fetchImpl,
    });
  }
}
