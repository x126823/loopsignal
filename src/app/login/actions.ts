"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { getEnv } from "@/lib/env";
import { signIn, signOut } from "@/modules/identity";
import { devLoginForm, formObject } from "../_lib/forms";

/** Dev sign-in for seeded synthetic users. Disabled in production by configuration and again inside the provider. */
export async function devSignIn(formData: FormData): Promise<void> {
  if (getEnv().AUTH_DEV_LOGIN !== "true") redirect("/login?error=disabled");
  const parsed = devLoginForm.safeParse(formObject(formData));
  if (!parsed.success) redirect("/login?error=invalid");
  try {
    await signIn("dev", { email: parsed.data.email, redirectTo: "/" });
  } catch (e) {
    if (e instanceof AuthError) redirect("/login?error=invalid"); // wrong or unknown user: say nothing more specific
    throw e; // NEXT_REDIRECT and real failures propagate
  }
}

export async function googleSignIn(): Promise<void> {
  await signIn("google", { redirectTo: "/" });
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/login" });
}
