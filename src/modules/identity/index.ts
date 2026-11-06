// Public API of the identity module. Other modules import only from here.
export { handlers, auth, signIn, signOut, SYNTHETIC_EMAIL_DOMAIN } from "./auth";
export { resolvePrincipal } from "./principal";
export { getSessionsValidAfter, revokeMemberSessions, revokeOwnSessions, sessionRevoked, type RevokeOutcome } from "./sessions";
export { assertCan, can, ForbiddenError, type Action, type PolicyOptions, type Principal, type Resource } from "./rbac";
