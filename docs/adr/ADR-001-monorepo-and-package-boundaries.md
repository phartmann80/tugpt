# ADR-001: Monorepo and Package Boundaries

## Status
Accepted

## Context
TuGPT.ai is a multi-service SaaS platform encompassing web applications, auth services, AI orchestration, background job processing, and security evaluators. To avoid code duplication while preserving strict architectural boundaries, we established a single canonical pnpm workspace monorepo.

## Decision
1. Strict directory separation:
   - `apps/web`: Next.js 16 application frontend and public/protected API routes.
   - `packages/*`: Modular, domain-focused TypeScript libraries with isolated dependencies.
2. Package boundaries:
   - `@tugpt/database`: Supabase client factories and TypeScript database schema definitions.
   - `@tugpt/auth`: Authentication operations, OAuth flows, session management, and tenant context resolution.
   - `@tugpt/security`: RLS policy contracts and local policy evaluator logic.
   - `@tugpt/observability`: Structured JSON logger and performance/latency metrics collector.
   - `@tugpt/ai-providers`: Standardized provider adapter interfaces for OpenAI, Langdock, Mastra, and custom LLM routing.
   - `@tugpt/feature-flags`: Feature flag evaluation service supporting global and tenant-level flag resolution.
   - `@tugpt/jobs`: Background task queue abstraction adapters.
3. Lockfile policy: Single root `pnpm-lock.yaml` is authoritative. No lockfiles allowed inside apps/ or packages/.

## Consequences
- Clean dependency isolation and Turbo build caching across workspace packages.
- Prevents circular imports and ensures code reuse across web, worker, and API layers.
- Strict build dependency order enforced by `turbo.json`.

## Security Implications
Prevents direct access to private internal utilities from public presentation components. Dependencies are explicit and auditable via root lockfile.
