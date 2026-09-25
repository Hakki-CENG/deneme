# regression-detector

Regression Detector Compares eval runs and detects regressions (score drops).  Features: - Detects overall score regressions - Identifies category-level regressions - Tracks individual task regressions - Severity classification (critical/high/medium/low) - Historical trend analysis - Alert generation

## Exports

| Name | Type | Description |
|------|------|-------------|
| `detectRegressions` | function | Compare two eval runs and detect regressions. |
| `analyzeTrend` | function | Analyze trend over multiple runs. |
| `formatRegressionReport` | function | Generate regression report as markdown. |
| `runRegressionDetection` | function |  |
| `EvalRunSummary` | interface |  |
| `Regression` | interface |  |
| `RegressionReport` | interface |  |
