import { describe, expect, it } from 'vitest';
import {
  AIProviderFactory,
  ProviderSelectionError,
  parseProviderSelection,
} from './factory';

describe('explicit provider selection', () => {
  it('registers only explicitly selected providers and ignores unrelated credentials', () => {
    const factory = new AIProviderFactory();

    const selection = factory.initializeFromEnv({
      AI_TEXT_PRIMARY_PROVIDER: 'logicc',
      LOGICC_API_KEY: 'logicc-test-key',
      LANGDOCK_API_KEY: 'unused-langdock-key',
      OPENAI_API_KEY: 'unused-openai-key',
    });

    expect(selection).toEqual({ primary: 'logicc', fallback: undefined });
    expect(factory.listRegisteredProviders()).toEqual(['logicc']);
  });

  it('registers an explicitly named fallback without changing its role', () => {
    const factory = new AIProviderFactory();

    const selection = factory.initializeFromEnv({
      AI_TEXT_PRIMARY_PROVIDER: 'logicc',
      AI_TEXT_FALLBACK_PROVIDER: 'langdock',
      LOGICC_API_KEY: 'logicc-test-key',
      LANGDOCK_API_KEY: 'langdock-test-key',
    });

    expect(selection).toEqual({ primary: 'logicc', fallback: 'langdock' });
    expect(factory.listRegisteredProviders()).toEqual(['langdock', 'logicc']);
  });

  it('leaves a selected provider unregistered when its credential is missing', () => {
    const factory = new AIProviderFactory();

    const selection = factory.initializeFromEnv({
      AI_TEXT_PRIMARY_PROVIDER: 'logicc',
      AI_TEXT_FALLBACK_PROVIDER: 'langdock',
      LANGDOCK_API_KEY: 'langdock-test-key',
    });

    expect(selection.primary).toBe('logicc');
    expect(factory.hasAdapter('logicc')).toBe(false);
    expect(factory.hasAdapter('langdock')).toBe(true);
  });

  it('clears prior registration before rejecting invalid replacement configuration', () => {
    const factory = new AIProviderFactory();
    factory.initializeFromEnv({
      AI_TEXT_PRIMARY_PROVIDER: 'logicc',
      LOGICC_API_KEY: 'logicc-test-key',
    });

    expect(() =>
      factory.initializeFromEnv({ AI_TEXT_PRIMARY_PROVIDER: 'mastra' })
    ).toThrow(ProviderSelectionError);
    expect(factory.listRegisteredProviders()).toEqual([]);
  });

  it.each([
    [{}, 'AI_TEXT_PRIMARY_PROVIDER'],
    [{ AI_TEXT_PRIMARY_PROVIDER: 'mastra' }, 'AI_TEXT_PRIMARY_PROVIDER'],
    [
      {
        AI_TEXT_PRIMARY_PROVIDER: 'logicc',
        AI_TEXT_FALLBACK_PROVIDER: 'logicc',
      },
      'must be different',
    ],
  ])('rejects invalid or ambiguous selection %#', (environment, message) => {
    expect(() => parseProviderSelection(environment)).toThrow(ProviderSelectionError);
    expect(() => parseProviderSelection(environment)).toThrow(message);
  });
});
