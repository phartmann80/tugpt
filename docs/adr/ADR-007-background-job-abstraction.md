# ADR-007: Background Job Abstraction

## Status
Accepted

## Context
Asynchronous processing is required for WhatsApp messaging, appointment notifications, quote generation, and background AI tasks.

## Decision
1. Queue Interface: Define `JobQueueAdapter` interface in `@tugpt/jobs`:
   - `enqueue<T>(queueName, jobName, payload, options)`
   - `process<T>(queueName, handler)`
2. Adapters:
   - `InMemoryJobQueue`: Local development and unit test queue runner.
   - Production adapter (BullMQ / Redis or Supabase PgBoss): Pluggable backend for production deployment.
3. Strict Payload Schemas: Every job payload must be strongly typed with JSON Schema / Zod validation.

## Consequences
- Decouples API handlers from async task processing.
- Supports offline testing and reliable background execution.

## Security Implications
Job payloads contain non-sensitive IDs and references. Sensitive credentials are never embedded in background job messages.
