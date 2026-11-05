import { redirect } from "next/navigation";
import { getEnv } from "@/lib/env";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { getContext, getSessionUser } from "../_lib/session";
import { devSignIn, googleSignIn, signOutAction } from "./actions";

const ERRORS: Record<string, string> = {
  invalid: "That sign-in was not recognised. Sign-in is by invitation only.",
  disabled: "Dev sign-in is turned off.",
  AccessDenied: "That account is not invited to LoopSignal.",
  CredentialsSignin: "That sign-in was not recognised. Sign-in is by invitation only.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const user = await getSessionUser();
  if (user && (await getContext())) redirect("/approvals");

  const env = getEnv();
  const devEnabled = env.AUTH_DEV_LOGIN === "true" && env.NODE_ENV !== "production";
  const googleEnabled = Boolean(env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET);
  const errorKey = Array.isArray(params["error"]) ? params["error"][0] : params["error"];
  const error = errorKey && Object.hasOwn(ERRORS, errorKey) ? ERRORS[errorKey] : errorKey ? "Sign-in failed." : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-4 py-10">
      <div>
        <h1 className="text-2xl font-semibold">LoopSignal</h1>
        <p className="mt-1 text-sm text-muted-foreground">Every message that needs action, tracked from receipt to formal closure.</p>
      </div>

      {error && <Notice tone="danger">{error}</Notice>}

      {user ? (
        <Card>
          <CardHeader>
            <CardTitle>No organization</CardTitle>
            <CardDescription>You are signed in as {user.email}, but you are not a member of any organization yet. Ask an administrator to add you.</CardDescription>
          </CardHeader>
          <CardContent>
            <form action={signOutAction}>
              <Button type="submit" variant="outline">Sign out</Button>
            </form>
          </CardContent>
        </Card>
      ) : (
        <>
          {googleEnabled && (
            <Card>
              <CardHeader>
                <CardTitle>Sign in with Google</CardTitle>
                <CardDescription>Use your invited Google account.</CardDescription>
              </CardHeader>
              <CardContent>
                <form action={googleSignIn}>
                  <Button type="submit" className="w-full">Continue with Google</Button>
                </form>
              </CardContent>
            </Card>
          )}
          {devEnabled && (
            <Card>
              <CardHeader>
                <CardTitle>Development sign-in</CardTitle>
                <CardDescription>Synthetic users only, for example carol@synthetic.loopsignal.test. No password, and never available in production.</CardDescription>
              </CardHeader>
              <CardContent>
                <form action={devSignIn} className="flex flex-col gap-3">
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" name="email" type="email" autoComplete="username" required placeholder="name@synthetic.loopsignal.test" />
                  <Button type="submit">Sign in</Button>
                </form>
              </CardContent>
            </Card>
          )}
          {!googleEnabled && !devEnabled && <Notice tone="warning">No sign-in method is configured.</Notice>}
        </>
      )}
    </main>
  );
}
