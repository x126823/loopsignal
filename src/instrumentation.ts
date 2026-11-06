/** Runs once when a server instance starts, before it accepts a request. See instrumentation-node.ts. */
export async function register(): Promise<void> {
  if (process.env["NEXT_RUNTIME"] === "nodejs") {
    (await import("./instrumentation-node")).validateEnvironmentOrExit();
  }
}
