# Aurora operator runbook

This is the day-two document for Aurora: what to look at, what the numbers mean, which knob to turn
and what to do when an alert fires. It assumes the deployment described in `README.md` and the layer
map in `docs/aurora-architecture.md`.

Every surface below exists in three places: a governed capability (for agents), a Control API route
(for operators and automation) and a Canvas section (for humans). Nothing in this runbook requires a
model to be running.

---

## 1. The five-minute health check

| Question | Where | Healthy looks like |
| --- | --- | --- |
| Is the organism intact? | `GET /v1/aurora/selfcheck?tenantId=…` | `healthy: true`, score ≥ 0.9, no `critical` findings |
| Is anything shouting? | `GET /v1/aurora/alerts?tenantId=…` | empty, or only `info` |
| Is cognition healthy? | `GET /v1/acos/status?tenantId=…` | `healthScore` ≥ 0.6, no degraded phases in the last cycle |
| Is governance biting too hard? | `GET /v1/aurora/enforcement-summary?tenantId=…` | escalation rate < 0.1, denials explainable |
| Is unattended work running? | `GET /v1/autopilot?tenantId=…`, `GET /v1/aurora/fleet` | `failureRate` < 0.25, no paused tenants |

From a terminal:

```bash
HAF_URL=https://haf.example HAF_API_TOKEN=… HAF_TENANT=acme haf-client aurora status
haf-client aurora alerts
haf-client aurora selfcheck
haf-client aurora enforcement-summary
haf-client aurora fleet
haf-client aurora help          # lists every allowlisted view and the three bounded actions
```

Scraping: `GET /metrics?tenant=…` includes the content-free `haf_aurora_*` gauges (cognition,
memory, world calibration, initiative trust, evolution, environment, decisions, plans, constitution,
autopilot and fleet). No titles, content or identifiers are ever exported.

---

## 2. Unattended operation

Aurora keeps thinking between conversations through two layers:

- **Autopilot** (`AuroraAutopilot`, per tenant) — runs due cadences: `pulse` (15 min), `maintenance`
  (hourly), `reflection` (daily), `dream` (off by default), `daily-briefing`, `weekly-review`,
  `monthly-strategy`. Bounded by a daily run ceiling, quiet hours and exponential failure backoff.
- **Fleet supervisor** (`AuroraFleetSupervisor`, across tenants) — the driver above the autopilot.
  It only drives tenants that were explicitly enrolled, sweeps them fairly (priority band first,
  then least-recently-swept), bounds each sweep, isolates failures per tenant and opens a circuit
  breaker on a tenant that keeps failing.

### Turning it on

```jsonc
// EngineConfig
{
  "autopilot": { "enabled": true, "tenantId": "acme", "driverIntervalMs": 60000 },
  "auroraFleet": {
    "enabled": true,
    "tenantIds": ["acme", "globex"],
    "sweepIntervalMs": 60000,
    "maxTenantsPerSweep": 25,
    "maxSweepsPerDay": 2000
  }
}
```

Use one or the other in most deployments: the fleet supervisor already calls each enrolled tenant's
autopilot, so enabling both simply means one tenant is also driven by its own timer.

### Operating the fleet

Fleet routes are **system-admin only**, because they are cross-tenant. A tenant's own agents can
reach only their own membership, through the tenant-scoped `aurora.fleet.*` capabilities.

```bash
curl -H "authorization: Bearer $ADMIN" $HAF/v1/aurora/fleet                 # fleet-wide health
curl -H … $HAF/v1/aurora/fleet/members                                     # enrollment list
curl -H … -X POST $HAF/v1/aurora/fleet/members \
  -d '{"tenantId":"acme","priority":5,"maxRunsPerSweep":4,"note":"primary"}'
curl -H … -X POST $HAF/v1/aurora/fleet/sweep -d '{}'                       # sweep now
curl -H … -X POST $HAF/v1/aurora/fleet/members/acme/resume                 # clear a breaker
curl -H … -X DELETE $HAF/v1/aurora/fleet/members/acme                      # stop driving a tenant
curl -H … $HAF/v1/aurora/fleet/sweeps?limit=20                             # durable sweep ledger
```

Canvas: **Aurora → fleet** shows membership, pause state, per-tenant counters and the sweep ledger,
with enroll / enable / resume / withdraw / sweep buttons.

### Tuning

| Knob | Default | Raise when | Lower when |
| --- | --- | --- | --- |
| `priority` (1-5) | 3 | a tenant is latency-sensitive | a tenant is background-only |
| `maxRunsPerSweep` | 4 | cadences are falling behind | one tenant dominates the budget |
| `maxTenantsPerSweep` | 25 | the fleet grows and sweeps lag | sweeps take too long or cost too much |
| `maxSweepsPerDay` | 2000 | never, normally | you need a hard spend ceiling |
| `maxRunsPerDay` (autopilot) | 96 | reflection is being skipped | model spend is too high |
| `quietHoursUtc` | none | users complain about night activity | you need round-the-clock reaction |

### The circuit breaker

Three consecutive failing sweeps pause a tenant. The pause is exponential
(15 → 30 → 60 → … minutes, capped at four hours) and shows up as `pausedUntil` / `pauseReason` on the
member and as the `fleet-tenant-paused` alert. Fix the cause, then `POST …/resume`; resuming clears
the failure counter. A tenant that sweeps cleanly clears itself.

---

## 2b. Delegated execution and role authority

Aurora can hand ready plan steps to society roles and reconcile the results back into the plan.

```bash
curl -H … "$HAF/v1/plans/$PLAN/delegation-report?tenantId=acme"   # coverage, roles, undelegated ready work
curl -H … -X POST $HAF/v1/plans/$PLAN/delegate -d '{"tenantId":"acme"}'
curl -H … -X POST $HAF/v1/delegations/$LINK/activate -d '{"tenantId":"acme"}'   # spawns the child session
curl -H … -X POST $HAF/v1/delegations/sync -d '{"tenantId":"acme"}'
curl -H … -X POST $HAF/v1/delegation-policy \
  -d '{"tenantId":"acme","autoDelegate":true,"rootSessionId":"…","maxActiveTasksPerPlan":3}'
haf-client aurora delegations
haf-client aurora delegation-sync
```

Reading a link: `status` tracks the society task (`posted → nominated → assigned → running →
completed|failed`), `match` records why that role was chosen (coverage, reputation, score), `outcome`
carries the child session's evidence event IDs. A step only becomes `done` because a task completed
with that evidence.

| Symptom | Cause | Fix |
| --- | --- | --- |
| `skipped: no-role-matches` | No active role covers the required tags | Add tags to a role, pass `capabilityTags`, or relax `requireRoleMatch` |
| `skipped: plan-concurrency-limit` | Plan already has its allowed tasks in flight | Raise `maxActiveTasksPerPlan` or wait |
| `skipped: society-concurrency-exhausted` | The society is already running its maximum tasks | Raise `maxConcurrentTasks` via `/v1/society/budget` or wait |
| `skipped: society-token-budget-exhausted` | The daily society token budget cannot cover the step | Raise the budget, lower the step estimate, or wait for the daily reset |
| Link stuck in `posted` | Nomination or award failed; the reason is on the link's `note` | Usually society budget or concurrency — check `/v1/society/budget` |
| `skipped: all-matching-roles-on-probation` | Every matching role has a failure rate above the threshold for this risk level | Fix the roles, lower `riskLevel`, or retune `probation` on the delegation policy |
| Plan blocked after a failure | A delegated task failed, which fails the step | Replan the step, or detach and re-delegate to another role |

**Outcome harvesting.** Settled delegated work is scored from recorded events and recorded
automatically only when the verdict is unambiguous.

```bash
curl -H … -X POST $HAF/v1/delegations/harvest -d '{"tenantId":"acme"}'
curl -H … "$HAF/v1/harvest-review?tenantId=acme"                      # what needs a human verdict
curl -H … -X POST $HAF/v1/harvest-review/$ID/resolve -d '{"tenantId":"acme","success":true}'
curl -H … -X POST $HAF/v1/harvest-policy \
  -d '{"tenantId":"acme","autoRecord":true,"failBelow":0.35,"successAtOrAbove":0.6,"settleAfterMs":60000}'
haf-client aurora harvest-review
haf-client aurora harvest
```

Failed and ambiguous outcomes also feed learning: each becomes a deduplicated capability gap
(`/v1/evolution/gaps`) plus candidate lessons (`/v1/experience/proposals`). Both are candidates only.
Disable with `learnFromFailures: false` on the harvest policy.

Each assessment stores the five weighted criteria behind its score, so a disputed quality number can
be recomputed rather than argued about. Widen `settleAfterMs` if work is being scored too eagerly;
widen the gap between `failBelow` and `successAtOrAbove` to send more cases to human review, narrow it
to record more automatically. Disabling `autoRecord` routes everything to the queue.

**Decision feedback.** When a plan finishes, the decision that produced it gets its outcome recorded
automatically, which is what keeps calibration honest.

```bash
curl -H … "$HAF/v1/decision-feedback/candidates?tenantId=acme"           # what is waiting on reality
curl -H … -X POST $HAF/v1/decision-feedback/reconcile -d '{"tenantId":"acme","dryRun":true}'
curl -H … -X POST $HAF/v1/decision-feedback/reconcile -d '{"tenantId":"acme"}'
curl -H … "$HAF/v1/decision-feedback/summary?tenantId=acme"
haf-client aurora decision-feedback-summary
```

Always dry-run first when tuning: the response shows the exact observed value, surprise and Brier score
that would be written. A human-recorded outcome is never overwritten, and a plan that is only executing
marks the decision executed rather than resolving it.

**Estimation calibration.** Delegated work records its real duration, and the calibrator turns those
pairs into a correction factor.

```bash
curl -H … -X POST $HAF/v1/estimation/ingest -d '{"tenantId":"acme"}'
curl -H … "$HAF/v1/estimation/profile?tenantId=acme"            # factor, accuracy, confidence, buckets
curl -H … "$HAF/v1/plans/$PLAN/estimation?tenantId=acme"        # per-step suggestions, with reasons
curl -H … -X POST $HAF/v1/plans/$PLAN/estimation/apply -d '{"tenantId":"acme"}'
curl -H … "$HAF/v1/society/probation?tenantId=acme"             # benched roles and what they block
haf-client aurora estimation-profile
haf-client aurora probation
```

A factor above 1 means the tenant under-estimates. Corrections need a minimum sample count and are
clamped, so early history cannot distort planning; applying one is a plan revision, visible in the
plan's own audit trail. If `estimates-biased` fires, run the apply step on the active plans.

**Role authority.** Without a bound profile, a delegated child session inherits the parent's full
capability set. Bring the society to least authority:

```bash
curl -H … $HAF/v1/society/authority/templates            # the eight archetypes
curl -H … $HAF/v1/society/authority/templates/coder      # resolved ids, ceiling, what was dropped
curl -H … -X POST $HAF/v1/society/authority/apply-all -d '{"tenantId":"acme"}'
curl -H … "$HAF/v1/society/authority/audit?tenantId=acme"
haf-client aurora role-authority
```

Tenants can add their own templates when the built-ins do not fit:

```bash
curl -H … -X POST $HAF/v1/society/authority/templates -d '{
  "tenantId":"acme","id":"reporter","title":"Reporting specialist","rationale":"Read-only reporting.",
  "allow":["aurora.metrics","aurora.alerts","plan.list"],"deny":[],"maxRisk":"pure"}'
curl -H … -X DELETE "$HAF/v1/society/authority/templates/reporter?tenantId=acme"
```

Built-in ids are reserved, built-ins cannot be removed, and a template that resolves to no capability
is rejected rather than stored.

Audit findings: `role-inherits-full-authority` (bind a template), `role-profile-missing` (the profile
was deleted — re-apply), `profile-drifted-above-template` (someone widened the allowlist by hand —
re-apply the template or justify the exception). A resolved template with a non-empty
`unmatchedPatterns` means the template drifted away from the catalog and needs updating.

---

## 2c. Session modes

One dial per session, with a tenant default:

```bash
curl -H … "$HAF/v1/session-modes"                                   # what each mode means
curl -H … "$HAF/v1/sessions/$SESSION/mode"
curl -H … -X POST $HAF/v1/sessions/$SESSION/mode \
  -d '{"permissionMode":"plan","reason":"Explore before touching anything."}'
curl -H … -X POST $HAF/v1/session-modes/defaults \
  -d '{"tenantId":"acme","permissionMode":"manual","sandboxMode":"workspace-write","allowBypass":false}'
curl -H … "$HAF/v1/sessions/$SESSION/mode/history"                  # who changed it, when and why
```

| Mode | Use it when |
| --- | --- |
| `plan` | You want exploration and a real plan, with nothing touched |
| `manual` | Default: ask before anything consequential |
| `acceptEdits` | A trusted editing session; stop prompting for file writes |
| `auto` | Edits and test runs proceed; network and external effects still ask |
| `dontAsk` | Unattended runs: fail fast instead of waiting on a prompt |
| `bypass` | Rare, gated per tenant; governance still applies |

A mode never overrides governance. If a call is denied with an `aurora_*`, `lifecycle_hook_*` or `opa_*`
reason code, changing the mode will not help — fix the rule or the call.

---

## 2d. Session archive, cost and repository commands

```bash
curl -H … -X POST $HAF/v1/sessions/$SESSION/archive -d '{"reason":"Migration finished."}'
curl -H … -X POST $HAF/v1/sessions/$SESSION/restore -d '{"reason":"Follow-up work."}'
curl -H … "$HAF/v1/session-archives?tenantId=acme&state=archived"
curl -H … "$HAF/v1/sessions/$SESSION/cost"
curl -H … "$HAF/v1/usage?tenantId=acme"
curl -H … -X POST $HAF/v1/model-prices \
  -d '{"tenantId":"acme","route":"openai:gpt-5","inputPerMillionUsd":10,"outputPerMillionUsd":30}'
curl -H … "$HAF/v1/sessions/$SESSION/commands"
haf-client aurora usage
haf-client aurora session-archives
```

If `unpricedSessions` is above zero, the price table is missing a route — costs for those sessions read
as zero and the rollup is understated. Add the route rather than assuming the spend was nil. Archived
sessions refuse everything except `session.close`; restore before resuming work.

---

## 2e. Supply-chain trust

```bash
curl -H … -X POST $HAF/v1/trust/publishers \
  -d '{"id":"acme","name":"Acme Tools","publicKey":"-----BEGIN PUBLIC KEY-----…"}'
curl -H … -X POST $HAF/v1/trust/pins \
  -d '{"kind":"skill","artifactId":"hub:formatter","version":"1.2.0","sha256":"…"}'
curl -H … "$HAF/v1/trust/decisions?limit=20"     # what would be refused, before you enforce
curl -H … -X POST $HAF/v1/trust/policy -d '{"tenantId":"acme","requireSignature":true,"requirePin":true}'
haf-client aurora trust-decisions
```

Roll it out in that order: register keys, pin what you already run, read the recorded verdicts until
they are all `allowed`, then turn enforcement on. Turning `requireSignature` on first will refuse every
unsigned artefact you already depend on. A `mismatched` pin with a `valid` signature is not a false
positive — it means the artefact moved.

---

## 2f. Managed settings and questions

```bash
# Point the engine at an enterprise floor (or set HAF_MANAGED_SETTINGS)
cat /etc/aurora/managed-settings.json
{ "permissionModeCeiling": "acceptEdits", "allowBypass": false, "deniedCapabilities": ["process.exec"] }

curl -H … "$HAF/v1/settings/effective?tenantId=acme&sessionId=$SESSION"
haf-client aurora settings
```

Read `provenance` before changing anything: each key names the layer that produced it and every layer
that tried. `locked` lists what the managed floor owns — those keys will not move for a project file, a
personal override or a flag, and `session.mode.set` refuses a mode above `permissionModeCeiling`.

Open questions from agents:

```bash
curl -H … "$HAF/v1/questions?tenantId=acme&pendingOnly=true"
curl -H … -X POST $HAF/v1/questions/$ID/answer -d '{"optionId":"option-2","answeredBy":"alice"}'
```

A question that times out returns `timedOut` to the agent — it does **not** pick a default. If agents
are timing out often, either nobody is watching the queue or the questions are being asked at the wrong
moment.

---

## 3. Alert playbook

| Alert | Meaning | First action |
| --- | --- | --- |
| `cognitive-health-low` | Workspace is thrashing or starved | `GET /v1/cognitive/health`; check loop detection and the deferred queue |
| `attention-budget-exhausted` | Reservations consumed the budget | Raise the budget or release stale reservations |
| `memory-health-low` | Contradictions or stale memories dominate | Run consolidation, then a contradiction scan |
| `world-inconsistent` | Conflicting current claims | Inspect `/v1/world/inconsistencies`; supersede the wrong claim |
| `prediction-miscalibrated` | Brier mean > 0.3 | Resolve open predictions; distrust confident forecasts until it drops |
| `initiative-trust-low` | Users rate proactivity unhelpful | Tighten worthiness thresholds; reduce the digest cadence |
| `verification-debt` | Completed actions lack verification | Find them in `/v1/environment/actions`; verify or mark failed |
| `decision-overconfidence` | Stated confidence beats observed success by > 0.2 | Review the worst decisions in `/v1/decisions-calibration` |
| `plans-stalled` | Active plans idle for a week | `GET /v1/plans?stalledDays=7`; replan or supersede |
| `constitution-compliance-low` | > 20% of reviewed decisions denied or sent to review | Read `/v1/constitution/decisions`; the agent is trying the wrong things |
| `autopilot-failing` | > 25% of unattended runs fail | Read the run ledger; disable the failing cadence while you fix it |
| `fleet-tenant-paused` | Circuit breaker opened | Read the sweep ledger for that tenant, fix, then resume |
| `delegation-failing` | Delegated plan work fails more than it succeeds | Read the failed links' outcomes; the role or the step decomposition is wrong |
| `roles-inherit-authority` | Over half the roles have no least-authority profile | `POST /v1/society/authority/apply-all` |
| `harvest-review-backlog` | Delegated outcomes are waiting for a human verdict | Work `/v1/harvest-review`; if the band is too wide, retune the thresholds |
| `plan-expectations-off` | Finished plans keep landing far from what their decisions expected | Read `/v1/decision-feedback`; the planning estimates or the decision confidence are wrong |
| `estimates-biased` | Measured durations say estimates are systematically off | `POST /v1/estimation/ingest`, then apply the calibration to active plans |
| `acos-degraded` | Last cycle had degraded phases | The cycle report names the phase and the error |

---

## 4. Governance incidents

Aurora governance binds at the capability boundary and is **escalation-only**: it can turn allow into
require-approval and require-approval into deny, but it can never grant authority another policy
layer withheld.

- *"An agent was denied and should not have been."* Read `GET /v1/aurora/enforcement?escalatedOnly=true`.
  Each entry names the matched rules and principles. If the rule is wrong, tune the thresholds
  (`confirmAtOrAbove`, `denyAtOrAbove`) or the risk policy mode; if the whole layer is wrong for your
  deployment, set `auroraGovernance.enabled: false` — the base policy layers still apply.
- *"Something destructive got through."* It should not have: critical patterns are denied outright.
  Capture the call from the enforcement log and the session events, add the pattern to
  `policy/risk-analyzer.ts`, and add a test in `test/aurora-policy-enforcement.test.ts`.
- *"The analyzer is broken."* The layer fails **closed in the safe direction**: on analyzer or
  constitution failure it stops escalating rather than opening a gate. Ordinary policy still applies.

---

## 5. Recovery

1. **Workspace damage.** `GET /v1/checkpoints?tenantId=…` lists snapshots. `POST /v1/checkpoints/{id}/diff`
   before restoring; `POST /v1/checkpoints/{id}/restore` takes an automatic safety checkpoint first,
   so the rollback is itself reversible.
2. **A bad self-improvement.** `GET /v1/harness/refinements` then `POST /v1/harness/refinements/{id}/rollback`.
   Rollback is ordered by application index, so several refinements in the same millisecond still
   unwind correctly.
3. **A bad learned lesson.** Distilled proposals are candidates only. Reject them:
   `POST /v1/experience/proposals/{id}/reject`.
4. **A tenant misbehaving unattended.** Disable the member (`enabled: false`) or withdraw it. Its
   autopilot configuration and ledger survive, so re-enrolling resumes exactly where it stopped.
5. **Whole-tenant panic switch.** `POST /v1/autopilot {"enabled": false}` plus withdrawing the tenant
   from the fleet stops all unattended activity without touching stored cognition.

---

## 6. Privacy and data requests

- Export: `GET /v1/aurora/export?tenantId=…[&userId=…]` — per-section digests included.
- Purge a user: `POST /v1/aurora/purge-user` with `dryRun: true` first. The response lists what would
  be removed *and* what is retained for audit, explicitly, rather than silently keeping it.
- Retention footprint: `GET /v1/aurora/footprint?tenantId=…`.
- Telemetry never contains content, so metrics may be shipped to a third party without a DPA change.

---

## 7. Weekly operator ritual

1. `haf-client aurora selfcheck` — integrity score and findings.
2. `haf-client aurora enforcement-summary` — is governance drifting?
3. `haf-client aurora fleet` and `fleet-sweeps` — is anything paused or starving?
3b. `haf-client aurora role-authority` and `delegations` — is anything over-privileged or stuck?
3c. `haf-client aurora harvest-review` — clear the outcome verdicts waiting on you.
4. Review distilled proposals; apply the good ones, reject the rest with a reason.
5. Review decisions due for review and record outcomes — calibration is only real if outcomes are
   recorded.
6. Skim the constitution's amendment log: every change should have a named approver.
