// Public API of the sources module. Other modules import only from here.
// Connections to mailboxes: OAuth consent, encrypted tokens, disconnect, push watch and notification handling.
export { gmailAdapterFor } from "./adapter";
export { gmailEnabled, GmailDisabledError, type SourcesDeps } from "./config";
export { disconnectGmail, listGmailConnections, type ConnectionView, type DisconnectOutcome } from "./connections";
export { ConnectionAuthFailedError, getAccessToken, markConnectionAuthFailed, rekeyCredentials, withAccessToken } from "./credentials";
export { beginGmailConnect, completeGmailConnect, makeState, OAUTH_COOKIE, OAuthError, readState, type ConnectedMailbox, type OAuthFailure } from "./oauth";
export { handleGmailPush, type PushDeps, type PushOutcome } from "./push";
export { ensureWatch, renewDueWatches, type RenewalSummary } from "./watch";
export {
  chatAdapterFor, chatEnabled, rekeyClaims, ChatClaimError, ChatDisabledError, listChatSpaces, makeClaimCode, parseSpace, removeChatSpace, startSpaceClaim, verifySpaceClaim,
  type ChatDeps, type ChatSpacesView, type ClaimFailure, type RemoveOutcome, type StartedClaim, type VerifyOutcome,
} from "./chat";
