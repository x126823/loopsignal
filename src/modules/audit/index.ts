// Public API of the audit module. Other modules import only from here.
export { anchorIsAuthentic, checkAnchor, makeAnchor, parseAnchorLine, type Anchor, type AnchorCheck } from "./anchor";
export { auditHashAt, auditHead, latestAuditEntry, recordAudit, verifyAuditChain, assertSafeMetadata, type AuditEntry, type AuditSummary, type ChainStatus } from "./audit";
