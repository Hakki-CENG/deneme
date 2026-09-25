# ADR-002: Idempotency and uncertain outcomes

Status: accepted

## Decision

Mutating control commands use `tenantId + clientId + commandId`. Side effects
use an effect idempotency key. A durable `started` record without a durable
result is reported as uncertain and is not automatically replayed.

## Rationale

Distributed systems cannot promise exactly-once execution for arbitrary
external APIs. Explicit uncertainty is safer than silently repeating a merge,
payment, deployment or message send.
