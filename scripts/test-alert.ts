// Send a test alert to the configured webhook, to prove alerting works end to end before you need it. It carries no data. See docs/runbooks/alerting.md.
//   npm run ops:test-alert
import { flushAlerts, raiseAlert } from "../src/lib/alerts";
import { getEnv } from "../src/lib/env";

async function main(): Promise<void> {
  if (!getEnv().ALERT_WEBHOOK_URL) throw new Error("ALERT_WEBHOOK_URL is not set: alerts are only being logged");
  const result = await raiseAlert("alert.test", {});
  await flushAlerts();
  console.log(JSON.stringify({ event: "alert.test", result }));
  process.exit(result === "sent" ? 0 : 1);
}
main().catch((e: Error) => { console.error(e.message); process.exit(1); });
