import { createSyntheticAdapter } from "./synthetic";
import { UnsupportedProviderError, type AdapterRegistry, type Provider, type ProviderAdapter } from "./types";

const synthetic = createSyntheticAdapter();

/** Default registry. Gmail and Google Chat adapters arrive in Sprints 11 and 12, test workspace only. */
export const getAdapter: AdapterRegistry = (provider: Provider): ProviderAdapter => {
  if (provider === "SYNTHETIC") return synthetic;
  throw new UnsupportedProviderError(provider);
};
