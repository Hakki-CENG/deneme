# ADR-001: Runtime boundaries

Status: accepted

## Decision

The product is split into experience, control, session-runtime, execution and
knowledge boundaries. One session actor owns one root family. Filesystem,
process, network and external side effects cross the capability broker.

## Consequences

- UI and channels never execute tools.
- The Python kernel is a client of the capability broker for governed actions.
- Provider credentials remain outside model-visible kernel state.
- Integrations can be ported independently instead of growing one agent class.
