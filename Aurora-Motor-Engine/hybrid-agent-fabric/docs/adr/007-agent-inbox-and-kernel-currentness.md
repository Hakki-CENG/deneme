# ADR 007 — Durable agent inbox and kernel currentness

- Status: Accepted
- Date: 2026-08-18

## Context

Directly dispatching an `agent.message` command blocks behind a busy session, has no immediate receipt, cannot distinguish steering from follow-up, and gives no durable account of a crash between acceptance and delivery. The Python bridge likewise needs to prevent a late or forged frame from reusing authority after an execution was cancelled or a kernel was replaced.

## Decision

### Agent inbox

Agent-to-agent traffic is admitted only through a host-owned family roster. Reach is limited to direct parent, sibling and child relationships. Sender identity is derived from the active session rather than accepted from model arguments.

Messages are persisted before delivery with states:

- `pending`: accepted but not owned by a delivery attempt;
- `claimed`: owned by one delivery attempt;
- `delivered`: inserted durably into target model context;
- `uncertain`: the owner disappeared or acceptance could not be confirmed.

A stale claim becomes `uncertain`; it is not automatically replayed. This preserves the project's rule that potentially side-effecting agent turns are never described as exactly once.

`auto` resolves to `steer` for a busy target and `follow_up` for an idle target. Steering enters at a model boundary in the active turn. Follow-up executes as a new serialized prompt. Rate, size and pending limits are enforced before enqueue. Broadcast expands only over the direct family roster.

The local profile uses owner-only atomic files. The distributed profile uses a tenant-scoped PostgreSQL table, atomic claim update and content-free LISTEN/NOTIFY wake-up. The table remains authoritative; durability does not depend on notification delivery.

### Kernel protocol

Each kernel process has a generation ID. Each execution receives:

- execution ID;
- random per-execution host token;
- bounded host-request counter;
- request IDs used as stable capability idempotency components.

A host request is accepted only while its generation, execution and token are current and the corresponding execute request is pending. Duplicate request IDs replay the cached host response instead of re-executing a capability.

CPython execution is synchronous. Therefore timeout or cancellation kills the process group, aborts in-flight broker work through `AbortSignal`, discards late frames and creates a new kernel on the next execution. Preserving a potentially still-running process is less important than preserving the authority boundary.

## Consequences

- Busy agents can be steered without cancelling/replaying the current turn.
- A receipt accurately distinguishes queued from context-delivered.
- Crash ambiguity is visible and operator-recoverable.
- Kernel variables are lost after timeout/cancellation, by design.
- File inbox operation is intended for the single-control local profile; PostgreSQL is the cross-process authority.
- Manual operator resolution/retry of uncertain messages remains follow-up work.
