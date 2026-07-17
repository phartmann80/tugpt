import type { OrganizationRole } from '@tugpt/database';

export interface UserContext {
  userId: string;
  organizationMemberships: Array<{
    organizationId: string;
    role: OrganizationRole;
  }>;
}

export class PolicyEvaluator {
  /**
   * Evaluates whether a user can access a specific resource belonging to an organization
   */
  public static canAccessTenantResource(
    user: UserContext,
    targetOrgId: string
  ): boolean {
    return user.organizationMemberships.some(
      (m) => m.organizationId === targetOrgId
    );
  }

  /**
   * Evaluates role hierarchy permission
   */
  public static hasRolePermission(
    user: UserContext,
    targetOrgId: string,
    allowedRoles: OrganizationRole[]
  ): boolean {
    const membership = user.organizationMemberships.find(
      (m) => m.organizationId === targetOrgId
    );

    if (!membership) return false;
    return allowedRoles.includes(membership.role);
  }

  /**
   * Evaluates owner-only actions (delete org, transfer ownership)
   */
  public static isOrgOwner(user: UserContext, targetOrgId: string): boolean {
    return this.hasRolePermission(user, targetOrgId, ['owner']);
  }
}
