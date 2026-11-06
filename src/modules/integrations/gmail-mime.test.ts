import { describe, expect, it } from "vitest";
import { createGmailAdapter, projectMessage } from "./gmail";
import { decodeEncodedWords, extractText, htmlToText, MAX_BODY_CHARS, parseAddress } from "./gmail-mime";
import type { GmailMessage, GmailPart } from "./google";
import { NormalizationError, type RawProviderEvent } from "./types";

const data = (s: string) => Buffer.from(s).toString("base64url");
const plain = (s: string): GmailPart => ({ mimeType: "text/plain", body: { data: data(s) } });
const html = (s: string): GmailPart => ({ mimeType: "text/html", body: { data: data(s) } });

describe("extractText", () => {
  it("reads a single text/plain body", () => {
    expect(extractText(plain("Hello there"))).toEqual({ text: "Hello there", hasAttachments: false });
  });

  it("prefers text/plain over html in a multipart/alternative", () => {
    expect(extractText({ mimeType: "multipart/alternative", parts: [plain("plain version"), html("<p>html version</p>")] }).text).toBe("plain version");
  });

  it("falls back to html reduced to text, dropping scripts, styles and tags", () => {
    const out = extractText(html("<style>p{color:red}</style><p>Order&nbsp;#42 &amp; more</p><script>alert(1)</script><br>Second&#33; line"));
    expect(out.text).toBe("Order #42 & more\n\nSecond! line");
  });

  it("walks nested multiparts and notes attachments without reading them", () => {
    const out = extractText({
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "multipart/alternative", parts: [plain("the body")] },
        { mimeType: "application/pdf", filename: "invoice.pdf", body: { attachmentId: "a1", data: data("SECRET ATTACHMENT BYTES") } },
        { mimeType: "text/plain", filename: "notes.txt", body: { attachmentId: "a2", data: data("SECRET TEXT ATTACHMENT") } }, // text, but still an attachment
      ],
    });
    expect(out).toEqual({ text: "the body", hasAttachments: true });
  });

  it("caps the length, and survives hostile nesting and garbage encodings", () => {
    expect(extractText(plain("x".repeat(MAX_BODY_CHARS + 500))).text).toHaveLength(MAX_BODY_CHARS);
    let deep: GmailPart = plain("buried");
    for (let i = 0; i < 100; i++) deep = { mimeType: "multipart/mixed", parts: [deep] };
    expect(extractText(deep).text).toBe(""); // beyond the depth cap: ignored, not a crash
    expect(() => extractText({ mimeType: "text/plain", body: { data: "%%%not base64%%%" } })).not.toThrow();
  });

  it("does not turn out-of-range numeric entities into characters", () => {
    expect(htmlToText("a&#99999999999;b")).toBe("a&#99999999999;b");
  });
});

describe("headers", () => {
  it("parses plain, quoted and bare addresses, lower-casing the address", () => {
    expect(parseAddress("Ada Lovelace <Ada@Example.COM>")).toEqual({ address: "ada@example.com", name: "Ada Lovelace" });
    expect(parseAddress('"Lovelace, Ada" <ada@example.com>')).toEqual({ address: "ada@example.com", name: "Lovelace, Ada" });
    expect(parseAddress("ada@example.com")).toEqual({ address: "ada@example.com" });
    expect(parseAddress("<ada@example.com>")).toEqual({ address: "ada@example.com" });
  });

  it("rejects values with no usable single address", () => {
    for (const bad of ["", "no address here", "a@b.c, d@e.f", "Undisclosed recipients:;"]) expect(parseAddress(bad), bad).toBeNull();
  });

  it("decodes RFC 2047 words in base64 and quoted-printable, and leaves unknown charsets alone", () => {
    expect(decodeEncodedWords("=?UTF-8?B?Q2Fmw6k=?=")).toBe("Café");
    expect(decodeEncodedWords("=?UTF-8?Q?Caf=C3=A9_au_lait?=")).toBe("Café au lait");
    expect(decodeEncodedWords("=?ISO-8859-1?Q?Andr=E9?= <a@b.c>")).toBe("André <a@b.c>");
    expect(decodeEncodedWords("=?x-unknown-charset?B?AAEC?=")).toBe("=?x-unknown-charset?B?AAEC?=");
    expect(parseAddress("=?UTF-8?B?Sm9zw6k=?= <jose@example.com>")).toEqual({ address: "jose@example.com", name: "José" });
  });
});

const message = (over: Partial<GmailMessage> = {}, headers: Array<[string, string]> = [["From", "Pat <pat@customer.test>"], ["Subject", "Printer jams"]]): GmailMessage => ({
  id: "m1", threadId: "t1", labelIds: ["INBOX", "UNREAD"], internalDate: String(Date.UTC(2026, 10, 1, 9, 0)),
  payload: { mimeType: "multipart/alternative", headers: headers.map(([name, value]) => ({ name, value })), parts: [plain("The printer jams every third sheet.")] },
  ...over,
});

describe("projectMessage", () => {
  it("keeps INBOX and SENT mail and skips drafts, spam, trash and unlabelled mail", () => {
    expect(projectMessage(message(), "support@synthetic.test")).not.toBeNull();
    expect(projectMessage(message({ labelIds: ["SENT"] }), "support@synthetic.test")).not.toBeNull();
    for (const labelIds of [["INBOX", "SPAM"], ["INBOX", "TRASH"], ["DRAFT"], ["CATEGORY_PROMOTIONS"], []]) {
      expect(projectMessage(message({ labelIds }), "support@synthetic.test"), labelIds.join()).toBeNull();
    }
  });

  it("is identical when only volatile labels change, so a re-read is never a conflicting re-send", () => {
    const a = projectMessage(message({ labelIds: ["INBOX", "UNREAD", "IMPORTANT"] }), "support@synthetic.test");
    const b = projectMessage(message({ labelIds: ["INBOX", "STARRED"] }), "SUPPORT@synthetic.test");
    expect(a).toEqual(b);
  });

  it("marks empty messages instead of storing nothing", () => {
    const m = message();
    m.payload = { mimeType: "image/png", headers: m.payload.headers!, body: { size: 0 } };
    expect(projectMessage(m, "support@synthetic.test")!.text).toBe("[no text content]");
  });
});

describe("normalize", () => {
  const adapter = createGmailAdapter({ client: {} as never, auth: { getToken: async () => "t", refresh: async () => "t" }, backfillDays: 7 });
  const event = (over: Record<string, unknown> = {}): RawProviderEvent => ({
    provider: "GMAIL", externalId: "m1", receivedAt: new Date(),
    payload: { ...projectMessage(message(), "support@synthetic.test"), ...over },
  });

  it("maps a customer message to INBOUND with sender, subject and thread", () => {
    expect(adapter.normalize(event())).toMatchObject({
      provider: "GMAIL", externalMessageId: "m1", externalThreadId: "t1", direction: "INBOUND", subject: "Printer jams",
      sender: { address: "pat@customer.test", displayName: "Pat" }, bodyText: "The printer jams every third sheet.", sentAt: new Date(Date.UTC(2026, 10, 1, 9, 0)),
    });
  });

  it("classifies direction: SENT or the mailbox's own address is OUTBOUND, a colleague's domain is INTERNAL, others INBOUND", () => {
    expect(adapter.normalize(event({ sent: true })).direction).toBe("OUTBOUND");
    expect(adapter.normalize(event({ from: "Support <SUPPORT@synthetic.test>" })).direction).toBe("OUTBOUND");
    expect(adapter.normalize(event({ from: "Colleague <sam@synthetic.test>" })).direction).toBe("INTERNAL");
    expect(adapter.normalize(event({ from: "pat@synthetic.test.evil.example" })).direction).toBe("INBOUND");
  });

  it("rejects malformed payloads with a stable code and no content", () => {
    for (const bad of [{ v: 2 }, { text: 5 }, { extra: "field" }, { sentAtMs: -1 }, { mailbox: "nope" }]) {
      let error: unknown;
      try { adapter.normalize(event(bad)); } catch (e) { error = e; }
      expect(error, JSON.stringify(bad)).toBeInstanceOf(NormalizationError);
      expect((error as Error).message).toBe("Malformed provider event: invalid_payload");
      expect((error as Error).message).not.toContain("printer");
    }
    expect(() => adapter.normalize(event({ from: "no address" }))).toThrow("Malformed provider event: invalid_sender");
  });
});
