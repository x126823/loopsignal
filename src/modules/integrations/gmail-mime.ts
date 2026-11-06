import type { GmailPart } from "./google";

/**
 * Pure helpers that turn a Gmail message resource into plain text and headers. Input is untrusted: depth and part counts are
 * capped, decoding never throws on garbage, and nothing here logs.
 */
export const MAX_BODY_CHARS = 100_000;
const MAX_DEPTH = 20;
const MAX_PARTS = 200;

const header = (part: GmailPart, name: string): string | undefined =>
  part.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
export const getHeader = header;

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Visible text of a message: its text/plain parts in order, else its HTML reduced to text. Attachments are never read. */
export function extractText(root: GmailPart): { text: string; hasAttachments: boolean } {
  const plain: string[] = [];
  const html: string[] = [];
  let attachments = false;
  let seen = 0;
  const walk = (part: GmailPart, depth: number): void => {
    if (depth > MAX_DEPTH || ++seen > MAX_PARTS) return;
    const isAttachment = Boolean(part.filename) || Boolean(part.body?.attachmentId);
    if (isAttachment) {
      attachments = true;
      return;
    }
    const type = (part.mimeType ?? "").toLowerCase();
    if (part.parts?.length) for (const child of part.parts) walk(child, depth + 1);
    else if (part.body?.data) {
      if (type === "text/plain" || type === "") plain.push(decodeBase64Url(part.body.data));
      else if (type === "text/html") html.push(decodeBase64Url(part.body.data));
    }
  };
  walk(root, 0);
  const text = (plain.length ? plain.join("\n") : html.map(htmlToText).join("\n")).replace(/\r\n/g, "\n").trim();
  return { text: text.slice(0, MAX_BODY_CHARS), hasAttachments: attachments };
}

/** RFC 2047 encoded words (=?UTF-8?B?...?= / =?UTF-8?Q?...?=) in a header value. Unknown charsets are left as they are. */
export function decodeEncodedWords(value: string): string {
  return value
    .replace(/(\?=)\s+(=\?)/g, "$1$2")
    .replace(/=\?([\w-]+)\?([bq])\?([^?]*)\?=/gi, (whole, charset: string, enc: string, data: string) => {
      try {
        const bytes = enc.toLowerCase() === "b"
          ? Buffer.from(data, "base64")
          : Buffer.from(data.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1");
        return new TextDecoder(charset.toLowerCase()).decode(bytes);
      } catch {
        return whole;
      }
    });
}

/** `Name <a@b.c>`, `"Last, First" <a@b.c>` or `a@b.c`. Null when no usable address is present. */
export function parseAddress(raw: string): { address: string; name?: string } | null {
  const value = decodeEncodedWords(raw).replace(/[\r\n]+/g, " ").trim();
  const angle = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(value);
  const address = (angle?.[1] ?? (/^[^<>\s,;"]+@[^<>\s,;"]+$/.test(value) ? value : "")).toLowerCase();
  if (!address || address.length > 320) return null;
  const name = angle ? value.slice(0, angle.index).trim().replace(/^"(.*)"$/, "$1").trim() : "";
  return name ? { address, name: name.slice(0, 200) } : { address };
}
