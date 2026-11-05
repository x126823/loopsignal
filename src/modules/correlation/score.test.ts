import { describe, expect, it } from "vitest";
import { extractReferences, MAX_WINDOW_MS, normalizeText, scorePair, SHOW_THRESHOLD, type MessageFeatures } from "./score";

const T0 = Date.UTC(2026, 9, 5, 9, 0);
const m = (o: Partial<MessageFeatures> & { text: string }): MessageFeatures => ({
  threadId: "t1", monitoredSourceId: "s1", sentAt: new Date(T0), subject: null, senderAddress: null, senderName: null, ...o,
});
const mail = m({ threadId: "mail", monitoredSourceId: "gmail", subject: "Outage on checkout page", text: "The checkout page returns an error for all our customers right now. Order #48213 failed.", senderAddress: "pat@customer.test", senderName: "Pat Customer" });
const chat = (o: Partial<MessageFeatures> = {}) => m({ threadId: "chat", monitoredSourceId: "chat", sentAt: new Date(T0 + 20 * 60_000), text: "Checkout is broken, customers get an error on the checkout page. Order #48213 is stuck.", senderName: "Pat Customer", ...o });

describe("scorePair", () => {
  it("scores a clear cross-channel duplicate above the review threshold, with explanations", () => {
    const s = scorePair(chat(), mail);
    expect(s.excluded).toBe(false);
    expect(s.score).toBeGreaterThanOrEqual(SHOW_THRESHOLD);
    expect(s.signals.map((x) => x.name)).toEqual(["time", "sender", "reference", "text"]);
    expect(s.signals.find((x) => x.name === "reference")?.value).toBe(1);
  });

  it("never lets time and sender alone reach the threshold: the matter itself must overlap", () => {
    const s = scorePair(chat({ text: "Could you send the quarterly invoice template for our finance team?", senderAddress: "pat@customer.test" }), mail);
    expect(s.score).toBeLessThan(SHOW_THRESHOLD);
  });

  it("is not fooled by an identical sender and instant timing when the topics differ", () => {
    const s = scorePair(chat({ sentAt: new Date(T0 + 60_000), text: "Please update the shipping address on my account.", senderAddress: "pat@customer.test" }), mail);
    expect(s.score).toBeLessThan(SHOW_THRESHOLD);
  });

  it("excludes the same thread, the same source and anything beyond the window", () => {
    expect(scorePair(chat({ threadId: "mail" }), mail).excluded).toBe("SAME_THREAD");
    expect(scorePair(chat({ monitoredSourceId: "gmail" }), mail).excluded).toBe("SAME_SOURCE");
    expect(scorePair(chat({ sentAt: new Date(T0 + MAX_WINDOW_MS + 1) }), mail)).toMatchObject({ excluded: "TOO_FAR_APART", score: 0 });
    expect(scorePair(chat({ sentAt: new Date(T0 - MAX_WINDOW_MS - 1) }), mail).excluded).toBe("TOO_FAR_APART");
    expect(scorePair(chat({ sentAt: new Date(T0 + MAX_WINDOW_MS) }), mail).excluded).toBe(false); // the boundary is inclusive
  });

  it("is symmetric in time and stays within 0..1", () => {
    const a = scorePair(chat({ sentAt: new Date(T0 - 20 * 60_000) }), mail);
    const b = scorePair(chat(), mail);
    expect(a.score).toBe(b.score);
    for (const s of [a, b, scorePair(chat({ text: "x" }), mail)]) { expect(s.score).toBeGreaterThanOrEqual(0); expect(s.score).toBeLessThanOrEqual(1); }
  });

  it("scores a different matter well below the threshold", () => {
    const s = scorePair(chat({ text: "Our printer on the third floor keeps jamming on double sided pages.", senderName: "Someone Else" }), mail);
    expect(s.score).toBeLessThan(SHOW_THRESHOLD - 0.1);
  });

  it("the stored rationale holds counts and numbers, never message text or the reference numbers themselves", () => {
    const text = JSON.stringify(scorePair(chat(), mail));
    expect(text).not.toMatch(/48213|checkout|customers/i);
  });

  it("does not match senders on empty or very short names", () => {
    expect(scorePair(chat({ senderName: "  " }), { ...mail, senderName: "  ", senderAddress: null }).signals.find((x) => x.name === "sender")?.value).toBe(0);
    expect(scorePair(chat({ senderName: "Al" }), { ...mail, senderName: "Al", senderAddress: null }).signals.find((x) => x.name === "sender")?.value).toBe(0);
  });
});

describe("text helpers", () => {
  it("normalizes to content words only", () => expect(normalizeText("The Checkout, please! It's broken.")).toEqual(["checkout", "broken"]));
  it("finds reference-like tokens", () => {
    expect([...extractReferences("Order #48213, ticket INV-0042, id 1234567, code E500 and 0xFF1A, but not 12 or 2026")].sort()).toEqual(["#48213", "0xff1a", "e500", "inv-0042", "1234567"].sort());
  });
});
