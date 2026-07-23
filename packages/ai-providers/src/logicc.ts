import {
  OpenAICompatibleChatAdapter,
  type OpenAICompatibleAdapterConfig,
} from './openai-compatible';

export interface LogiccConfig {
  readonly apiKey: string;
  readonly endpointUrl?: string;
  readonly defaultModel?: string;
  readonly fetchImpl?: OpenAICompatibleAdapterConfig['fetchImpl'];
}

/** Logicc's documented OpenAI-compatible Chat Completions transport. */
export class LogiccAdapter extends OpenAICompatibleChatAdapter {
  constructor(config: LogiccConfig) {
    super('logicc', {
      apiKey: config.apiKey,
      endpointUrl: config.endpointUrl ?? 'https://api.logicc.io/v1',
      defaultModel: config.defaultModel ?? 'gpt-5-nano',
      fetchImpl: config.fetchImpl,
    });
  }
}
