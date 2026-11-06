import { createSyntheticAdapter } from "./synthetic";
import { UnsupportedProviderError, type Provider, type ProviderAdapter } from "./types";

const synthetic = createSyntheticAdapter();

/**
 * Adapters that need no credentials. Gmail is built per connection by src/modules/sources (it needs that connection's tokens),
 * and Google Chat arrives in Sprint 12.
 */
export const getAdapter = (provider: Provider): ProviderAdapter => {
  if (provider === "SYNTHETIC") return synthetic;
  throw new UnsupportedProviderError(provider);
};
