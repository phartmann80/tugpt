# ADR-009: Observability and Audit Logging

## Status
Accepted

## Context
Production compliance requires structured log telemetry and immutable audit logging for security events (login, organization creation, role changes, data modifications).

## Decision
1. Application Telemetry: `@tugpt/observability` provides `Logger` generating structured JSON records (`timestamp`, `level`, `message`, `context`, `error`).
2. Performance & Latency: `MetricsCollector` records latency metrics, execution durations, and AI token counts.
3. Database Audit Logging: `public.audit_logs` table stores:
   - `id`, `organization_id`, `actor_id`, `action`, `resource`, `details` (jsonb), `ip_address`, `created_at`.
4. Append-Only Enforcement: RLS policies on `audit_logs` allow `INSERT` and `SELECT` for authenticated members, but strictly reject `UPDATE` and `DELETE` queries for non-superusers.

## Consequences
- Guaranteed audit trail for forensic investigation.
- Real-time observability formatted for cloud logging aggregators (Datadog, GCP Cloud Logging).

## Security Implications
Audit trail cannot be tampered with or deleted by malicious organization admins or compromised user accounts.
