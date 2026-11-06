import { describe, expect, it } from "vitest";
import { buildCsp, formActionOriginsFor, staticSecurityHeaders } from "./security-headers";

const directive = (csp: string, name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `) || d === name);

describe("content security policy", () => {
  const csp = buildCsp({ nonce: "abc123", isDev: false });

  it("allows scripts only with this request's nonce, never inline or eval in production", () => {
    expect(directive(csp, "script-src")).toBe("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toContain("unsafe-eval");
    expect(directive(csp, "script-src")).not.toContain("unsafe-inline");
  });

  it("forbids plugins, framing, foreign base URLs and mixed content", () => {
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(csp, "base-uri")).toBe("base-uri 'self'");
    expect(directive(csp, "default-src")).toBe("default-src 'self'");
    expect(csp).toContain("upgrade-insecure-requests");
    expect(directive(csp, "connect-src")).toBe("connect-src 'self'");
  });

  it("allows only style attributes inline, which cannot run script, and nonce'd style elements", () => {
    expect(directive(csp, "style-src")).toBe("style-src 'self' 'nonce-abc123'");
    expect(directive(csp, "style-src-attr")).toBe("style-src-attr 'unsafe-inline'");
  });

  it("loosens only what development needs (eval for React stack traces, sockets for hot reload) and never adds https upgrades there", () => {
    const dev = buildCsp({ nonce: "n", isDev: true });
    expect(directive(dev, "script-src")).toContain("'unsafe-eval'");
    expect(directive(dev, "connect-src")).toContain("ws:");
    expect(directive(dev, "style-src")).toBe("style-src 'self' 'unsafe-inline'"); // the dev server's own style elements carry no nonce
    expect(dev).not.toContain("upgrade-insecure-requests");
  });

  it("a different nonce gives a different policy, and a nonce cannot smuggle in a directive", () => {
    expect(buildCsp({ nonce: "one", isDev: false })).not.toBe(buildCsp({ nonce: "two", isDev: false }));
    expect(buildCsp({ nonce: "x", isDev: false }).split("; ").every((d) => /^[a-z-]+( |$)/.test(d))).toBe(true);
  });

  it("lets a form end up only on this site and the listed consent origins", () => {
    expect(directive(csp, "form-action")).toBe("form-action 'self'");
    expect(directive(buildCsp({ nonce: "n", isDev: false, formActionOrigins: ["https://accounts.google.com"] }), "form-action")).toBe("form-action 'self' https://accounts.google.com");
  });
});

describe("form-action origins", () => {
  it("is Google's consent screen, plus the test double outside production only", () => {
    expect(formActionOriginsFor({ NODE_ENV: "production" })).toEqual(["https://accounts.google.com"]);
    expect(formActionOriginsFor({ NODE_ENV: "production", GOOGLE_TEST_BASE_URL: "http://127.0.0.1:4010" })).toEqual(["https://accounts.google.com"]);
    expect(formActionOriginsFor({ NODE_ENV: "development", GOOGLE_TEST_BASE_URL: "http://127.0.0.1:4010/path" })).toEqual(["https://accounts.google.com", "http://127.0.0.1:4010"]);
    expect(formActionOriginsFor({ NODE_ENV: "development", GOOGLE_TEST_BASE_URL: "not a url" })).toEqual(["https://accounts.google.com"]);
  });
});

describe("static security headers", () => {
  it("always stop sniffing, framing, referrer leaks and powerful browser features", () => {
    const h = Object.fromEntries(staticSecurityHeaders(false).map((x) => [x.key, x.value]));
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["Permissions-Policy"]).toMatch(/camera=\(\).*microphone=\(\).*geolocation=\(\)/);
    expect(h["Cross-Origin-Opener-Policy"]).toBe("same-origin");
  });

  it("pin https in production only", () => {
    expect(staticSecurityHeaders(false).some((x) => x.key === "Strict-Transport-Security")).toBe(false);
    expect(staticSecurityHeaders(true).find((x) => x.key === "Strict-Transport-Security")?.value).toContain("max-age=63072000");
  });
});
