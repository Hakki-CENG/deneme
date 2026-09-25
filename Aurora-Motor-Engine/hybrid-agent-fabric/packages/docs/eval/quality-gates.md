# quality-gates

Quality Gates CI/CD integration for enforcing quality standards before deployments.  Features: - Minimum score threshold - Maximum regression count - Budget limits - Performance thresholds - Category-specific gates - Pass/Fail verdict with detailed report

## Exports

| Name | Type | Description |
|------|------|-------------|
| `runQualityGates` | function |  |
| `formatQualityGateReport` | function | Format quality gate report as markdown. |
| `QualityGateConfig` | interface |  |
| `GateCheck` | interface |  |
| `QualityGateResult` | interface |  |
| `DEFAULT_GATES` | const |  |
