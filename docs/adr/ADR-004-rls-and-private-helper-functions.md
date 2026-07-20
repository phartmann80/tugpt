# ADR-004: RLS and Private Helper Functions

## Status
Accepted

## Context
Supabase managed `auth` schema must remain untouched. Placing custom helper functions in public schema exposes them to PostgREST HTTP RPC calls unless explicitly restricted.

## Decision
1. Dedicated private schema: `CREATE SCHEMA IF NOT EXISTS private;`.
2. Public schema access revoked: `REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;`.
3. Security Definer helper functions:
   - `private.is_org_member(p_org_id, p_user_id)`
   - `private.get_user_org_role(p_org_id, p_user_id)`
   - `private.has_org_role(p_org_id, p_user_id, p_min_role)`
4. Hardened Security Definer config: All private functions declare `SECURITY DEFINER` and explicitly set `SET search_path = public, private, pg_temp` to eliminate search_path escalation vulnerabilities.
5. Mandatory RLS & Force RLS: Every business table (`profiles`, `organizations`, `organization_members`, `organization_invitations`, `audit_logs`, `feature_flags`) enables RLS (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY;`) and enforces RLS for table owners (`ALTER TABLE ... FORCE ROW LEVEL SECURITY;`).
6. Append-only Audit Logs: `public.audit_logs` permits `SELECT` and `INSERT` for organization members, but rejects all `UPDATE` and `DELETE` attempts.

## Consequences
- RLS checks execute safely without recursion or exposing internal query logic.
- Table owners and superusers cannot bypass RLS restrictions.

## Security Implications
- Prevents HTTP RPC exposure of internal helper routines.
- Immutability of audit logs ensures audit trail integrity.
