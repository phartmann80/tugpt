# ADR-008: API Versioning and Authorization

## Status
Accepted

## Context
TuGPT.ai API routes must support client evolution while enforcing strict authentication and organization-level authorization.

## Decision
1. URI Versioning: All API routes reside under `/api/v1/`.
2. Standard Response Contract:
   - Success: `{ success: true, data: ... }` or resource payload with ISO-8601 timestamp.
   - Failure: `{ error: string, code?: string }` with appropriate HTTP status codes (400, 401, 403, 404, 500).
3. Distributed Tracing: Every incoming request receives or generates a unique `x-request-id` header passed into loggers and response headers.
4. Authorization Guardrails:
   - `401 Unauthorized` for missing or expired sessions.
   - `403 Forbidden` for tenant context mismatch or insufficient RBAC roles.
   - Zero Secret Leakage: Stack traces and internal database errors are swallowed in production and logged privately via `@tugpt/observability`.

## Consequences
- Predictable and uniform API error handling for web frontend and external integrations.
- Full request trace correlation across distributed services.

## Security Implications
Prevents sensitive system information leakage during internal server failures.
