import { describe, expect, it, vi } from 'vitest';
import { AuthService } from './service';
import type { TypedSupabaseClient } from '@tugpt/database';

function createMockSupabase(memberships: Array<{
  organization_id: string;
  role: 'owner' | 'admin' | 'manager' | 'agent' | 'viewer';
  organizations: { id: string; name: string; deleted_at: string | null } | null;
}>) {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: 'user-1', email: 'user@tugpt.ai', user_metadata: {} } },
        error: null,
      }),
      signInWithOAuth: vi.fn(),
      signUp: vi.fn(),
      signInWithPassword: vi.fn(),
      resetPasswordForEmail: vi.fn(),
      updateUser: vi.fn(),
      refreshSession: vi.fn(),
      signOut: vi.fn(),
    },
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'organization_members') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockResolvedValue({
            data: memberships,
            error: null,
          }),
        };
      }
      if (table === 'profiles') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: {
              id: 'user-1',
              email: 'user@tugpt.ai',
              full_name: 'Test User',
              avatar_url: null,
            },
            error: null,
          }),
        };
      }
      return {};
    }),
  } as unknown as TypedSupabaseClient;
}

describe('AuthService Multi-Tenant Context Resolution', () => {
  it('resolves requested tenant when user is an active member', async () => {
    const supabase = createMockSupabase([
      {
        organization_id: 'org-1',
        role: 'owner',
        organizations: { id: 'org-1', name: 'Org One', deleted_at: null },
      },
      {
        organization_id: 'org-2',
        role: 'agent',
        organizations: { id: 'org-2', name: 'Org Two', deleted_at: null },
      },
    ]);

    const service = new AuthService(supabase);
    const tenant = await service.resolveTenantContext('user-1', 'org-2');

    expect(tenant).not.toBeNull();
    expect(tenant?.organizationId).toBe('org-2');
    expect(tenant?.organizationName).toBe('Org Two');
    expect(tenant?.role).toBe('agent');
  });

  it('returns null when requested tenant is not in user active memberships', async () => {
    const supabase = createMockSupabase([
      {
        organization_id: 'org-1',
        role: 'owner',
        organizations: { id: 'org-1', name: 'Org One', deleted_at: null },
      },
    ]);

    const service = new AuthService(supabase);
    const tenant = await service.resolveTenantContext('user-1', 'org-unauthorized');

    expect(tenant).toBeNull();
  });

  it('filters out soft-deleted organizations (deleted_at IS NOT NULL)', async () => {
    const supabase = createMockSupabase([
      {
        organization_id: 'org-deleted',
        role: 'owner',
        organizations: { id: 'org-deleted', name: 'Deleted Org', deleted_at: '2026-07-01T00:00:00Z' },
      },
      {
        organization_id: 'org-active',
        role: 'admin',
        organizations: { id: 'org-active', name: 'Active Org', deleted_at: null },
      },
    ]);

    const service = new AuthService(supabase);
    const orgs = await service.getUserOrganizations('user-1');

    expect(orgs).toHaveLength(1);
    expect(orgs[0].organizationId).toBe('org-active');

    // Requesting soft-deleted org returns null
    const deletedContext = await service.resolveTenantContext('user-1', 'org-deleted');
    expect(deletedContext).toBeNull();
  });

  it('defaults to first active organization when requestedTenantId is omitted', async () => {
    const supabase = createMockSupabase([
      {
        organization_id: 'org-default',
        role: 'owner',
        organizations: { id: 'org-default', name: 'Default Org', deleted_at: null },
      },
      {
        organization_id: 'org-secondary',
        role: 'viewer',
        organizations: { id: 'org-secondary', name: 'Secondary Org', deleted_at: null },
      },
    ]);

    const service = new AuthService(supabase);
    const tenant = await service.resolveTenantContext('user-1');

    expect(tenant).not.toBeNull();
    expect(tenant?.organizationId).toBe('org-default');
  });

  it('returns null if user has no active organization memberships', async () => {
    const supabase = createMockSupabase([]);

    const service = new AuthService(supabase);
    const tenant = await service.resolveTenantContext('user-1');

    expect(tenant).toBeNull();
  });
});
