// Public API of the reporting module. Other modules import only from here.
export { buildDashboard, METRIC_KEYS, percentile, type AttentionItem, type DashboardData, type MetricKey, type MetricSummary, type Rollup, type SlaSummary } from "./aggregate";
export { DEFAULT_WINDOW_DAYS, getDashboard, isWindowDays, WINDOW_DAYS, type Dashboard, type WindowDays } from "./service";
