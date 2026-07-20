# ADR-005: Active Organization Context Resolution

## Status
Accepted

## Context
Client requests may supply an `x-tenant-id` HTTP header or cookie. Header inputs are untrusted and must never be accepted as proof of organization membership.

## Decision
1. Server-Side Tenant Resolution: All tenant context resolution must be computed server-side within `@tugpt/auth` via `AuthService.resolveTenantContext(userId, requestedTenantId)`.
2. Active Membership Validation: If a client supplies `x-tenant-id`, the server queries `organization_members` for the authenticated user ID and verifies active (non-deleted) membership.
3. Fallback behavior: If no `x-tenant-id` is supplied, the server defaults to the user's primary/first active organization membership.
4. Authorization Rejection: If the user passes an `x-tenant-id` for an organization they are not an active member of, the API route immediately aborts with `403 Forbidden`.

## Consequences
- Prevents header forgery and cross-tenant data leakage.
- Ensures all downstream business logic executes with a validated, authoritative tenant ID.

## Security Implications
Guarantees complete multi-tenant isolation regardless of client-side request header manipulation.
