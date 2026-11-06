import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import type { Provider } from "next-auth/providers";
import { getEnv } from "@/lib/env";
import { findUserByEmail } from "./users";

/** Dev login only ever accepts synthetic users. */
export const SYNTHETIC_EMAIL_DOMAIN = "@synthetic.loopsignal.test";

function buildProviders(): Provider[] {
  const env = getEnv();
  const providers: Provider[] = [];
  if (env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET) {
    providers.push(Google({ clientId: env.AUTH_GOOGLE_ID, clientSecret: env.AUTH_GOOGLE_SECRET }));
  }
  // parseEnv already refuses AUTH_DEV_LOGIN=true in production; re-check here as a second guard.
  if (env.AUTH_DEV_LOGIN === "true" && env.NODE_ENV !== "production") {
    providers.push(
      Credentials({
        id: "dev",
        name: "Synthetic user (dev)",
        credentials: { email: { label: "Synthetic email", type: "email" } },
        async authorize(credentials) {
          const email = String(credentials?.["email"] ?? "").trim().toLowerCase();
          if (!email.endsWith(SYNTHETIC_EMAIL_DOMAIN)) return null;
          const user = await findUserByEmail(email);
          return user ? { id: user.id, email: user.email, name: user.name } : null;
        },
      }),
    );
  }
  return providers;
}

export const { handlers, auth, signIn, signOut } = NextAuth(() => ({
  providers: buildProviders(),
  // A sign-in lasts SESSION_HOURS from the moment of sign-in. (JWT sessions are not extended by server-rendered requests, so this is a hard
  // limit, not an idle timeout.) A person or an administrator can also end every session early: see sessions.ts.
  session: { strategy: "jwt" as const, maxAge: getEnv().SESSION_HOURS * 3600 },
  pages: { signIn: "/login", error: "/login" }, // our own sign-in page (it also shows sign-in errors)
  secret: getEnv().AUTH_SECRET,
  // Development trusts the request host. Production must NOT: left unset, Auth.js trusts the host only when AUTH_URL pins it, and the env
  // schema refuses to start a production process without one. (Setting this to `false` explicitly would make every production sign-in
  // fail with UntrustedHost, even with AUTH_URL set, because an explicit value overrides that detection.)
  ...(getEnv().NODE_ENV !== "production" ? { trustHost: true } : {}),
  callbacks: {
    /** Invite-only: Google sign-in succeeds only for a verified email that already has a User row. */
    async signIn({ account, profile, user }) {
      if (account?.provider === "dev") return true; // authorize() already verified the synthetic user
      if (account?.provider === "google") {
        const email = profile?.email;
        if (!email || profile?.email_verified !== true) return false;
        return (await findUserByEmail(email)) !== null;
      }
      return Boolean(user);
    },
    /** Pin the token subject to our database user id (not the provider's id). */
    async jwt({ token, account }) {
      if (account && token.email) {
        const dbUser = await findUserByEmail(token.email);
        if (!dbUser) throw new Error("Authenticated user no longer exists");
        token.sub = dbUser.id;
      }
      return token;
    },
    /** The session carries identity only. Org and role are resolved server-side via resolvePrincipal. */
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      (session as unknown as { issuedAt?: number }).issuedAt = typeof token.iat === "number" ? token.iat : undefined; // lets the app tell whether the session predates a revocation
      return session;
    },
  },
}));
