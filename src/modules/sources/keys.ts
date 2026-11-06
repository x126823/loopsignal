import { getEnv } from "@/lib/env";
import { createKeySource, googleEndpoints, type KeySource } from "@/modules/integrations";

let shared: KeySource | undefined;
/** Process-wide cache of Google's signing keys. */
export function createGoogleKeySource(): KeySource {
  shared ??= createKeySource(googleEndpoints(getEnv().GOOGLE_TEST_BASE_URL).certs);
  return shared;
}
