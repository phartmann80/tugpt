# ADR-002: Supabase Authentication Strategy

## Status
Accepted

## Context
TuGPT.ai requires Google OAuth, email/password authentication, password resets, email verification, session refresh, and server-side route protection.

## Decision
1. Utilize Supabase Auth as the primary Identity Provider (IdP).
2. Store extended user profile data in `public.profiles` linked 1:1 to `auth.users(id)` via foreign key with `ON DELETE CASCADE`.
3. Use `@tugpt/auth` `AuthService` as the unified wrapper for all authentication interactions (Google OAuth via `signInWithOAuth`, password auth via `signUp`/`signInWithPassword`, and session refresh).
4. Protected route enforcement handled via Next.js 16 Proxy (`apps/web/src/proxy.ts`).

## Alternatives Considered
- Custom JWT auth: Rejected due to operational complexity and security risk compared to Supabase managed Auth.
- NextAuth.js: Rejected to maintain direct integration with Supabase RLS and JWT session claims.

## Consequences
- Single source of truth for user identities in `auth.users`.
- Direct pass-through of JWT claims to PostgreSQL RLS context (`request.jwt.claim.sub`).

## Security Implications
- Client applications never handle raw passwords or long-lived secret credentials.
- Automatic session token expiration and refresh handling via Supabase client SDKs.
