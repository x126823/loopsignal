import { parseFieldKey } from "@/lib/crypto/fields";
import { getEnv } from "@/lib/env";
import { createGoogleClient, googleEndpoints, type GoogleClient } from "@/modules/integrations";

/** Everything here can be replaced in tests; production reads the environment. */
export interface SourcesDeps {
  client?: GoogleClient;
  now?: () => Date;
  fieldKey?: Buffer;
}

export const gmailEnabled = (): boolean => getEnv().GMAIL_ENABLED === "true";

export class GmailDisabledError extends Error {
  constructor() {
    super("The Gmail integration is not enabled");
    this.name = "GmailDisabledError";
  }
}

export function resolveDeps(deps: SourcesDeps = {}): Required<SourcesDeps> {
  const env = getEnv();
  return {
    client: deps.client ?? createGoogleClient({ endpoints: googleEndpoints(env.GOOGLE_TEST_BASE_URL), clientId: env.GOOGLE_OAUTH_CLIENT_ID ?? "", clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET ?? "" }),
    now: deps.now ?? (() => new Date()),
    fieldKey: deps.fieldKey ?? parseFieldKey(env.FIELD_ENCRYPTION_KEY),
  };
}

export const redirectUri = (): string => `${getEnv().APP_BASE_URL.replace(/\/$/, "")}/api/gmail/callback`;
