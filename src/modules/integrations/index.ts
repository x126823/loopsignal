// Public API of the integrations module. Other modules import only from here.
// Adapters fetch and normalize only: no business logic, no database access.
export { getAdapter } from "./registry";
export { createSyntheticAdapter, syntheticInbox, type SyntheticOptions, type SyntheticPayload } from "./synthetic";
export {
  NormalizationError, UnsupportedProviderError,
  type AdapterRegistry, type Direction, type FetchPage, type NormalizedMessage, type Provider, type ProviderAdapter, type RawProviderEvent, type SourceRef,
} from "./types";
