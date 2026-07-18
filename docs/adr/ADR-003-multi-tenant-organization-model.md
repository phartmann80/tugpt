# ADR-003: Multi-Tenant Organization Model

## Status
Accepted

## Context
TuGPT.ai is a multi-tenant B2B SaaS platform. Data must be segregated by organization, with defined role-based access control (RBAC).

## Decision
1. Organization entity: `public.organizations` with `id`, `name`, `slug`, `created_at`, `updated_at`, and `deleted_at` (soft deletion).
2. Membership entity: `public.organization_members` mapping `organization_id` and `user_id` with enum role: `'owner'`, `'admin'`, `'manager'`, `'agent'`, `'viewer'`.
3. Atomic creation: Organization creation MUST occur via `private.create_organization_with_owner(p_name, p_slug, p_owner_id)`, inserting the organization row and initial owner membership row inside a single PostgreSQL transaction.
4. Invitation security: `public.organization_invitations` stores SHA-256 `token_hash` instead of plaintext secrets. Invitation acceptance occurs via atomic transaction `private.accept_invitation(p_token_hash, p_user_id)` validating email identity match, row locking (`FOR UPDATE`), and token expiration.

## Consequences
- Guarantees every created organization has at least one valid owner.
- Eliminates invitation token reuse and unauthorized account takeover risks.

## Security Implications
- Soft-deleted organizations are immediately excluded from queries via RLS policies.
- Role hierarchy strictly enforced at both database (RLS) and API layers.
