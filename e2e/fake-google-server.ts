// Runs the fake Google (tests/helpers/fake-google.ts) as a standalone server for the browser tests: node --import tsx e2e/fake-google-server.ts
import { FakeGoogle } from "../tests/helpers/fake-google";

async function main(): Promise<void> {
  const fake = new FakeGoogle();
  fake.clientId = process.env["GOOGLE_OAUTH_CLIENT_ID"] ?? fake.clientId;
  fake.clientSecret = process.env["GOOGLE_OAUTH_CLIENT_SECRET"] ?? fake.clientSecret;
  await fake.start(Number(process.env["FAKE_GOOGLE_PORT"] ?? 4010));
  console.log(`fake google listening on ${fake.baseUrl}`);
  const stop = () => void fake.stop().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
void main();
