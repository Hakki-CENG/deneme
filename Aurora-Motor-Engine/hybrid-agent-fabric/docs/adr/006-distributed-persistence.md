# ADR-006: PostgreSQL is authoritative; NATS is transport

Status: accepted

## Decision

Local mode uses file adapters. Distributed mode uses PostgreSQL for events,
snapshots, command/effect journals and expiring session leases. NATS carries
event fan-out and worker command request/reply but is not authoritative state.

## Invariants

- Event ID and session sequence are unique.
- A notification is only a wake-up; consumers read the durable row.
- A started command/effect without a durable result is uncertain and is not
  automatically replayed.
- Journal rows contain an execution owner to distinguish concurrent runtimes.
- Snapshots cannot regress generation or sequence.
- Session lease takeover requires expiration or release.
- Raw tenant IDs do not appear in NATS subject names.
