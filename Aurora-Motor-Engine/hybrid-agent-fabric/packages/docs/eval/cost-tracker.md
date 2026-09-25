# cost-tracker

Cost Tracker Monitors token usage and calculates costs for eval runs.  Features: - Token usage tracking per task/category/difficulty - Cost calculation (configurable pricing) - Budget monitoring and alerts - Cost efficiency analysis - Token optimization recommendations

## Exports

| Name | Type | Description |
|------|------|-------------|
| `runCostTracking` | function |  |
| `formatCostReport` | function | Format cost report as markdown. |
| `ModelPricing` | interface |  |
| `CostEntry` | interface |  |
| `CostStats` | interface |  |
| `CategoryCost` | interface |  |
| `DifficultyCost` | interface |  |
| `BudgetAlert` | interface |  |
| `CostReport` | interface |  |
| `DEFAULT_PRICING` | const |  |
