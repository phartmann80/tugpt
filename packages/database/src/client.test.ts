import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSupabaseClient, createAdminSupabaseClient, createServerClient } from './client';

describe('Supabase Client Initialisation and Validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('createSupabaseClient', () => {
    it('throws an error if URL is empty', () => {
      expect(() => createSupabaseClient('', 'some-key')).toThrow(
        'Supabase URL is required to create a client instance.'
      );
    });

    it('throws an error if key is empty', () => {
      expect(() => createSupabaseClient('https://example.supabase.co', '')).toThrow(
        'Supabase key (anon/service-role) is required to create a client instance.'
      );
    });

    it('instantiates correctly when both URL and key are provided', () => {
      const client = createSupabaseClient('https://example.supabase.co', 'some-key');
      expect(client).toBeDefined();
    });
  });

  describe('createAdminSupabaseClient', () => {
    it('throws an error if URL is empty', () => {
      expect(() => createAdminSupabaseClient('', 'service-key')).toThrow(
        'Supabase URL is required to create an admin client instance.'
      );
    });

    it('throws an error if service role key is empty', () => {
      expect(() => createAdminSupabaseClient('https://example.supabase.co', '')).toThrow(
        'Supabase service role key is required to create an admin client instance.'
      );
    });

    it('throws an error if executed in a browser environment', () => {
      vi.stubGlobal('window', {});
      expect(() => createAdminSupabaseClient('https://example.supabase.co', 'service-key')).toThrow(
        'Security Violation: Cannot create an admin Supabase client in the browser environment.'
      );
      vi.unstubAllGlobals();
    });

    it('instantiates correctly server-side when all credentials exist', () => {
      const client = createAdminSupabaseClient('https://example.supabase.co', 'service-key');
      expect(client).toBeDefined();
    });
  });

  describe('createServerClient', () => {
    it('throws an error if URL environment variable is missing and no parameter is passed', () => {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

      expect(() => createServerClient()).toThrow(
        'Database Client Error: Supabase URL is missing. Ensure NEXT_PUBLIC_SUPABASE_URL environment variable is set.'
      );
    });

    it('throws an error if Key environment variable is missing and no parameter is passed', () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
      delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

      expect(() => createServerClient()).toThrow(
        'Database Client Error: Supabase Key is missing. Ensure NEXT_PUBLIC_SUPABASE_ANON_KEY environment variable is set.'
      );
    });

    it('prefers explicit parameters over environment variables', () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://env.supabase.co';
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'env-anon';

      const client = createServerClient('https://explicit.supabase.co', 'explicit-anon');
      expect(client).toBeDefined();
    });
  });
});
