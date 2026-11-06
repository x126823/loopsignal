// Public API of the integrations module. Other modules import only from here.
// Adapters fetch and normalize only: no business logic, no database access.
export { getAdapter } from "./registry";
export { createSyntheticAdapter, syntheticInbox, type SyntheticOptions, type SyntheticPayload } from "./synthetic";
export { createChatAdapter, projectChatMessage, type ChatAdapterOptions, type ChatPayload, type ChatTokens } from "./google-chat-adapter";
export { CHAT_APP_MESSAGES_READONLY_SCOPE, createChatClient, SPACE_NAME, type ChatClient, type ChatMessage } from "./google-chat";
export { createServiceAccountTokens, parseServiceAccountKey, type ServiceAccountKey, type ServiceAccountTokens } from "./google-service-account";
export { createGmailAdapter, projectMessage, type GmailAdapterOptions, type GmailAuth, type GmailPayload } from "./gmail";
export { createGoogleClient, GMAIL_READONLY_SCOPE, googleEndpoints, type GoogleClient, type GoogleEndpoints, type TokenGrant } from "./google";
export { createKeySource, verifyPubSubToken, type KeySource, type TokenVerdict } from "./google-oidc";
export {
  NormalizationError, ProviderApiError, ProviderAuthError, ProviderCursorExpiredError, ProviderRateLimitError, ProviderSourceUnavailableError, UnsupportedProviderError,
  type AdapterContext, type AdapterRegistry, type Direction, type FetchPage, type NormalizedMessage, type Provider, type ProviderAdapter, type RawProviderEvent, type SourceRef,
} from "./types";
