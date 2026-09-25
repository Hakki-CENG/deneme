# ADR-003: Dual execution lane

Status: accepted

## Decision

Use a persistent Python compute lane for composition and a typed governed
capability lane for side effects. Production Python kernels run inside the
sandbox fabric with no long-lived credentials and restricted egress.

## Consequences

- RLM productivity is retained.
- Policy, approval, audit and credential scope remain enforceable.
- `haf.call()` is the kernel-to-host bridge.
