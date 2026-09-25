# difficulty-scorer

Difficulty Scorer Weights eval tasks by difficulty level and provides adaptive task selection.  Difficulty levels: 1 = Trivial (basic operations) 2 = Easy (single-step tasks) 3 = Medium (multi-step, some complexity) 4 = Hard (complex reasoning, multiple subsystems) 5 = Expert (long-horizon, adversarial, edge cases)

## Exports

| Name | Type | Description |
|------|------|-------------|
| `loadTaskDifficulties` | function |  |
| `calculateDifficultyScore` | function |  |
| `selectAdaptiveTasks` | function |  |
| `formatDifficultyReport` | function |  |
| `TaskDifficulty` | interface |  |
| `DifficultyScore` | interface |  |
| `DifficultyRecommendation` | interface |  |
