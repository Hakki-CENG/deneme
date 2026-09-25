# continuous-monitor

Continuous Monitor Automated eval scheduling and alert system for ongoing quality monitoring.  Features: - Scheduled eval runs (configurable interval) - Alert system (email, webhook, log) - Health check endpoint - Status dashboard - Automatic recovery attempts

## Exports

| Name | Type | Description |
|------|------|-------------|
| `checkHealth` | function |  |
| `generateMonitorReport` | function |  |
| `saveAlert` | function |  |
| `checkAlertConditions` | function |  |
| `formatMonitorReport` | function | Format monitor report as markdown. |
| `runContinuousMonitor` | function |  |
| `MonitorConfig` | interface |  |
| `MonitorStatus` | interface |  |
| `MonitorAlert` | interface |  |
| `MonitorReport` | interface |  |
| `DEFAULT_MONITOR_CONFIG` | const |  |
