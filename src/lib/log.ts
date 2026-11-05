/**
 * Structured logging for workers and jobs. Fields are restricted to ids, counts and flags by type, so message
 * content, tokens and secrets cannot be logged by accident (rule 10). Never add free-text fields here.
 */
type Safe = string | number | boolean | null | undefined;

export function log(level: "info" | "warn" | "error", event: string, fields: Record<string, Safe> = {}): void {
  const line = JSON.stringify({ level, event, at: new Date().toISOString(), ...fields });
  (level === "error" ? console.error : console.log)(line);
}
