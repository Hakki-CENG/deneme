# auto-recovery

Auto-Recovery Automatic recovery mechanisms for failed eval runs.  Features: - Automatic retry on transient failures - Fallback strategies for different failure types - Circuit breaker pattern - Recovery history tracking - Self-healing recommendations

## Exports

| Name | Type | Description |
|------|------|-------------|
| `analyzeFailure` | function | Analyze failure and suggest recovery strategy. |
| `generateRecoveryReport` | function |  |
| `saveRecoveryAttempt` | function |  |
| `formatRecoveryReport` | function | Format recovery report as markdown. |
| `runAutoRecovery` | function |  |
| `RecoveryConfig` | interface |  |
| `RecoveryAttempt` | interface |  |
| `CircuitBreakerState` | interface |  |
| `RecoveryReport` | interface |  |
| `DEFAULT_RECOVERY_CONFIG` | const |  |
