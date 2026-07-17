import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './types';

export type TypedSupabaseClient = SupabaseClient<Database>;

export function createSupabaseClient(
  supabaseUrl: string,
  supabaseKey: string,
  options?: Parameters<typeof createClient>[2]
): TypedSupabaseClient {
  return createClient<Database>(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
    ...options,
  });
}

export function createAdminSupabaseClient(
  supabaseUrl: string,
  serviceRoleKey: string
): TypedSupabaseClient {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
