// Public API of the audit module. Other modules import only from here.
export { latestAuditEntry, recordAudit, verifyAuditChain, assertSafeMetadata, type AuditEntry, type AuditSummary, type ChainStatus } from "./audit";
