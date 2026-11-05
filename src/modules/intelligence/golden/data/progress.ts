import { goldenCase as c } from "../types";

const REQ: Array<["in", string]> = [["in", "Please help: the CSV export is missing the region column."]];
const p = (id: string, text: string, isProgress: boolean, note?: string) => c(id, { isProgress }, [...REQ, ["out", text]], note ? { note } : {});

/** Progress analyzer golden set. expected.isProgress: does OUR last message report work underway? */
export const PROGRESS_CASES = [
  p("progress-engineer", "We have identified the cause and an engineer is working on the fix now.", true),
  p("progress-review", "The fix is in review and scheduled to ship on Thursday.", true),
  p("progress-provisioning", "Provisioning has started and should finish tomorrow.", true),
  p("progress-escalated", "We have escalated this to the networking team, who will investigate today.", true),
  p("progress-underway", "Work on the export is underway; I will update you when the patch is ready.", true),
  p("progress-investigating", "Our developers are investigating why the column is dropped.", true),
  p("progress-ack", "Thanks, we have received this and will look into it.", false, "an acknowledgment is not a progress report"),
  p("progress-info-request", "Could you send the exact error message you see?", false),
  p("progress-refund", "The refund was issued today and should arrive in three days.", false, "a finished action, not work in flight"),
  p("progress-patience", "Thank you for your patience.", false),
  p("progress-get-back", "We will get back to you shortly.", false),
  p("progress-resolved", "This is now fixed. Please let us know if it works for you.", false, "a resolution claim is a different decision"),
  c("progress-customer-last", { isProgress: false }, [["out", "We are on it."], ["in", "Is an engineer working on this yet? It is urgent."]], { note: "the customer asking about progress is not our progress update" }),
  p("progress-apology", "We are sorry for the inconvenience.", false),
  p("progress-ticket", "I have opened a ticket with the data team and they are investigating the missing column.", true),
  p("progress-workaround", "As a workaround, export in two batches for now.", false, "an answer, not a status update"),
];
