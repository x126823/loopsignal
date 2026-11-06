// Public API of the retention module. Other modules import only from here.
// How long content is kept, removing it when it is due, erasing a person, and checking that the audit chain is intact.
export { verifyAllAuditChains, type AuditVerification } from "./audit-verify";
export { erasePerson, type ErasureResult } from "./erase";
export { runRetention, type RetentionDeps, type RetentionRun } from "./run";
export { getRetention, InvalidRetentionError, RETENTION_DEFAULTS, RETENTION_LIMITS, retentionSchema, setRetention, type Retention } from "./settings";
export { getRetentionStatus, type RetentionStatus } from "./status";
