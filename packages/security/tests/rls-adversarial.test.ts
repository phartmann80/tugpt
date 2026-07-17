import { describe, expect, it } from 'vitest';
import { PolicyEvaluator, type UserContext } from '../src/policy-evaluator';

describe('Adversarial Security & Row-Level Isolation Tests', () => {
  const userTenantA: UserContext = {
    userId: 'user-a-uuid',
    organizationMemberships: [
      { organizationId: 'org-tenant-a', role: 'owner' },
    ],
  };

  const userTenantB: UserContext = {
    userId: 'user-b-uuid',
    organizationMemberships: [
      { organizationId: 'org-tenant-b', role: 'agent' },
    ],
  };

  describe('Cross-Tenant Data Isolation', () => {
    it('prevents User A from accessing Tenant B resources', () => {
      const canAccess = PolicyEvaluator.canAccessTenantResource(
        userTenantA,
        'org-tenant-b'
      );
      expect(canAccess).toBe(false);
    });

    it('allows User B to access their own Tenant B resources', () => {
      const canAccess = PolicyEvaluator.canAccessTenantResource(
        userTenantB,
        'org-tenant-b'
      );
      expect(canAccess).toBe(true);
    });
  });

  describe('Role Enforcement & Permission Escalation Prevention', () => {
    it('prevents Agent role from updating organization settings', () => {
      const canUpdateSettings = PolicyEvaluator.hasRolePermission(
        userTenantB,
        'org-tenant-b',
        ['owner', 'admin']
      );
      expect(canUpdateSettings).toBe(false);
    });

    it('allows Owner and Admin roles to manage members and settings', () => {
      const canManage = PolicyEvaluator.hasRolePermission(
        userTenantA,
        'org-tenant-a',
        ['owner', 'admin']
      );
      expect(canManage).toBe(true);
    });
  });

  describe('Owner Protection', () => {
    it('restricts soft-delete of organization strictly to Owner role', () => {
      const canDeleteOrg = PolicyEvaluator.isOrgOwner(
        userTenantB,
        'org-tenant-b'
      );
      expect(canDeleteOrg).toBe(false);

      const isOwnerDeleteAllowed = PolicyEvaluator.isOrgOwner(
        userTenantA,
        'org-tenant-a'
      );
      expect(isOwnerDeleteAllowed).toBe(true);
    });
  });

  describe('Invitation Security', () => {
    it('restricts invitation creation to Owner and Admin roles', () => {
      const canInviteUserB = PolicyEvaluator.hasRolePermission(
        userTenantB,
        'org-tenant-b',
        ['owner', 'admin']
      );
      expect(canInviteUserB).toBe(false);

      const canInviteUserA = PolicyEvaluator.hasRolePermission(
        userTenantA,
        'org-tenant-a',
        ['owner', 'admin']
      );
      expect(canInviteUserA).toBe(true);
    });
  });
});
