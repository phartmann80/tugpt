# ADR-010: Feature Flag Architecture

## Status
Accepted

## Context
TuGPT.ai needs capability toggles for canary rollouts, tier-based feature gating (e.g. WhatsApp AI vs basic CRM), and multi-tenant flag overrides.

## Decision
1. Feature Flag Entity: `public.feature_flags` table storing:
   - `key`: Unique flag identifier string.
   - `enabled`: Global boolean flag toggle.
   - `organization_id`: Nullable foreign key for organization-specific overrides.
   - `description`: Explanatory text.
2. Flag Evaluation Service: `@tugpt/feature-flags` package `FeatureFlagService`:
   - Evaluates organization-specific override first.
   - Falls back to global flag state if no tenant override exists.
3. Access Control: Feature flag definitions are readable by authenticated members, but writable only by platform superusers / admins.

## Consequences
- Dynamic feature activation without code redeployments.
- Multi-tenant customization support.

## Security Implications
Prevents unauthorized access to unreleased features or restricted enterprise capabilities.
