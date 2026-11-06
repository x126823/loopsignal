// Public API of the integrations module. Other modules import only from here.
// Adapters fetch and normalize only: no business logic, no database access.
export { getAdapter } from "./registry";
export { createSyntheticAdapter, syntheticInbox, type SyntheticOptions, type SyntheticPayload } from "./synthetic";
export { createGmailAdapter, projectMessage, type GmailAdapterOptions, type GmailAuth, type GmailPayload } from "./gmail";
export { createGoogleClient, GMAIL_READONLY_SCOPE, googleEndpoints, type GoogleClient, type GoogleEndpoints, type TokenGrant } from "./google";
export { createKeySource, verifyPubSubToken, type KeySource, type TokenVerdict } from "./google-oidc";
export {
  NormalizationError, ProviderApiError, ProviderAuthError, ProviderCursorExpiredError, ProviderRateLimitError, UnsupportedProviderError,
  type AdapterContext, type AdapterRegistry, type Direction, type FetchPage, type NormalizedMessage, type Provider, type ProviderAdapter, type RawProviderEvent, type SourceRef,
} from "./types";
