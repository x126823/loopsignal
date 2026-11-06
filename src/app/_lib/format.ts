// Plain-language durations for dashboards. Pure.

/** 45 -> "45s", 300 -> "5m", 4500 -> "1h 15m", 200000 -> "2d 8h". Null (no data) -> an em dash. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`;
}

export const formatPercent = (pct: number | null): string => (pct === null ? "—" : `${pct}%`);
