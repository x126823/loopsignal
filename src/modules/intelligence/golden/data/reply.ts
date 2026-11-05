import { goldenCase as c } from "../types";

const REQ: Array<["in", string]> = [["in", "Please help: the CSV export is missing the region column."]];
const reply = (id: string, text: string, expected: Record<string, boolean>, note?: string) => c(id, expected, [...REQ, ["out", text]], note ? { note } : {});

/**
 * Replies from our team, labeled for the acknowledgment-vs-substantive distinction (rule 5). `ack` is whether the
 * LAST message is acknowledgment-only; `sub` is whether it is a substantive response. They are never both true.
 */
const L = (id: string, text: string, ack: boolean, sub: boolean, note?: string) => ({ id, text, ack, sub, note });

export const REPLY_LABELS = [
  // Acknowledgment only
  L("ack-received", "Thanks, we have received this and will look into it.", true, false),
  L("ack-on-it", "Got it, we are on it.", true, false),
  L("ack-get-back", "Received, thank you. We will get back to you shortly.", true, false),
  L("ack-looking-now", "We are looking into this now.", true, false),
  L("ack-team-review", "Thanks for reaching out, a team member will review this soon.", true, false),
  L("ack-acknowledged", "Acknowledged, looking into it.", true, false),
  // Substantive
  L("sub-reset", "I have reset your password. Please try signing in again.", false, true),
  L("sub-refund", "The refund was issued today and should arrive within three business days.", false, true),
  L("sub-cause", "Thanks, we have received this. The cause was an expired certificate, which we have now rotated.", false, true, "acknowledges AND answers: substantive, not ack-only"),
  L("sub-info-request", "Could you send the exact error message you see on screen?", false, true, "a specific question needed to proceed is substantive"),
  L("sub-attachment", "Attached is last month's invoice, as requested.", false, true),
  L("sub-cant-reproduce", "We cannot reproduce this on our side. Can you share your browser version?", false, true),
  L("sub-date", "The fix will ship on Thursday afternoon.", false, true),
  L("sub-workaround", "As a workaround, export in two batches until the fix is released.", false, true),
  // Neither
  L("neither-patience", "Thank you for your patience.", false, false, "pleasantry: neither an acknowledgment of receipt nor an answer"),
  L("neither-sorry", "We are sorry for the inconvenience.", false, false),
] as const;


/** A customer message as the LAST message: never our acknowledgment or response. */
export const CUSTOMER_LAST_ACK = c("ack-customer-last", { isAcknowledgment: false }, [["out", "Thanks, we have received this."], ["in", "Received your note, thanks. Any update on this?"]], { note: "customer wording must not count as ours" });
export const CUSTOMER_LAST_SUB = c("sub-customer-last", { isSubstantive: false }, [["out", "We are looking into it."], ["in", "I have reset my password myself and attached the screenshot."]], { note: "customer wording must not count as ours" });

export const ACK_CASES = [...REPLY_LABELS.map((l) => reply(`ack-${l.id}`, l.text, { isAcknowledgment: l.ack }, l.note)), CUSTOMER_LAST_ACK];
export const SUBSTANTIVE_CASES = [...REPLY_LABELS.map((l) => reply(`sub-${l.id}`, l.text, { isSubstantive: l.sub }, l.note)), CUSTOMER_LAST_SUB];
