/**
 * Provider adapter contract. Adapters only fetch and normalize: no business logic, no database access, no state
 * changes (CLAUDE.md architecture conventions). Provider payloads are untrusted input: `normalize` validates
 * them and throws NormalizationError, whose message is a stable code and never contains message content.
 */
export type Provider = "GMAIL" | "GOOGLE_CHAT" | "SYNTHETIC";
export type Direction = "INBOUND" | "OUTBOUND" | "INTERNAL";

export interface SourceRef {
  kind: "MAILBOX" | "LABEL" | "SPACE";
  externalId: string;
}

/** What the provider sent, exactly as received (stored encrypted and immutable by ingestion). */
export interface RawProviderEvent {
  provider: Provider;
  /** Provider's id for this event; the dedupe key together with the organization and provider. */
  externalId: string;
  receivedAt: Date;
  payload: unknown;
}

export interface FetchPage {
  events: RawProviderEvent[];
  /** Where the next fetch resumes. Always set after a successful fetch, even at the end of the data. */
  nextCursor: string;
  hasMore: boolean;
  /** The provider said the old cursor is no longer usable, so this page restarts from a bounded window (replays dedupe). */
  notice?: "RESYNC";
}

export interface NormalizedMessage {
  provider: Provider;
  externalMessageId: string;
  externalThreadId: string;
  sentAt: Date;
  direction: Direction;
  sender: { address: string; displayName?: string };
  subject?: string;
  bodyText: string;
}

export class NormalizationError extends Error {
  /** Stable machine-readable code, e.g. "invalid_payload". Never message content. */
  constructor(readonly code: string) {
    super(`Malformed provider event: ${code}`);
    this.name = "NormalizationError";
  }
}

export class UnsupportedProviderError extends Error {
  constructor(provider: string) {
    super(`No adapter registered for provider ${provider}`);
    this.name = "UnsupportedProviderError";
  }
}

/** Credentials were refused (revoked, expired for good, or missing a scope). Retrying cannot help; the connection needs a person. */
export class ProviderAuthError extends Error {
  constructor(readonly code: "invalid_grant" | "unauthorized" | "forbidden") {
    super(`Provider rejected the credentials: ${code}`);
    this.name = "ProviderAuthError";
  }
}

/** Throttled, and still throttled after our own retries. Transient: the job retries later with backoff. */
export class ProviderRateLimitError extends Error {
  constructor() {
    super("Provider is rate limiting requests");
    this.name = "ProviderRateLimitError";
  }
}

/** Any other provider failure. The message carries the status only, never a response body (bodies can hold content). */
export class ProviderApiError extends Error {
  constructor(readonly status: number) {
    super(`Provider request failed with status ${status}`);
    this.name = "ProviderApiError";
  }
}

/** The stored cursor is too old or unreadable (Gmail: history gap). The adapter normally recovers by itself. */
export class ProviderCursorExpiredError extends Error {
  constructor() {
    super("Provider cursor expired");
    this.name = "ProviderCursorExpiredError";
  }
}

export interface ProviderAdapter {
  readonly provider: Provider;
  /** Fetch up to `limit` events after `cursor` (null on the first sync). */
  fetch(source: SourceRef, cursor: string | null, limit: number): Promise<FetchPage>;
  /** Validate and map a raw event to the common shape. Pure. Throws NormalizationError when malformed. */
  normalize(event: RawProviderEvent): NormalizedMessage;
}

/** Which connection an adapter is for. Providers with credentials (Gmail) need it; the synthetic one ignores it. */
export interface AdapterContext {
  organizationId: string;
  connectionId: string;
}

export type AdapterRegistry = (provider: Provider, context?: AdapterContext) => ProviderAdapter | Promise<ProviderAdapter>;
