# Aurora — Current State

**Generated:** 2026-09-25 by `npm run docs:state -w @haf/eval`. Do not edit by hand;
regenerate it. See the header of `packages/eval/src/runner/state-docs-cli.ts`
for why this file is generated.

## Measured baseline

| Measurement | Value |
|---|---|
| Test files | 254 |
| Test cases (declared) | 1879 + 1 table-driven declaration(s), so the runner reports slightly more |
| Modules in the maturity register | 30 |
| Modules declared wired (hand-written) | 30 |
| Modules observed doing work in a real task (measured) | 28 |
| Acceptance gates in CI | 4 (`npm run eval:gates`) |

## What the levels mean

A module sits at the highest rung it can actually reach. Each rung implies the
ones before it.

| Level | Means |
|---|---|
| `implemented` | Source exists. |
| `initialized` | The engine constructs it. |
| `reachable` | Callable from a public entry point. |
| `integrated` | Wired into the real execution path (`wiredToEngine`). |
| `exercised` | A test drives it (`hasTests`). |
| `verified` | An acceptance gate measures it. |
| `production` | Verified **and** production evidence recorded in the maturity register (`productionEvidence`). Declaring `stable` is not enough: an acceptance gate measures this repository, which is what `verified` means. Nothing here can produce that evidence on its own, so the row is empty until somebody records it. |

**implemented: 0 · initialized: 0 · reachable: 2 · integrated: 0 · exercised: 25 · verified: 3 · production: 0**

## Honest summary

- The distinction that matters most here is `integrated` vs `exercised` vs
  `verified`. Most of this system is *exercised* — tests drive it. Far less is
  *verified*, meaning an acceptance gate would fail if it regressed.
- Only 0 module(s) reach `production`.
  That is not a defect report; it is the cost of using a strict definition.
- The full execution contract lives in
  `packages/engine/src/execution/execution-status.ts`:
  `skipped`, `simulated`, `unverified`, `unavailable` and `blocked` are each
  distinct from `succeeded`.

## Verifying this document

```bash
npm run check          # typecheck + the full suite
npm run eval:gates     # the four acceptance gates
npm run docs:state -w @haf/eval   # regenerate these documents
```
