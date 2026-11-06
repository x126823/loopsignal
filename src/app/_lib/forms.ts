import { z } from "zod";

/**
 * Form input is untrusted: every server action validates its FormData with these schemas and then re-resolves the caller
 * and re-checks authorization itself. Hidden fields (ids, expected version) are convenience, never authority.
 */
const uuid = z.string().uuid();
const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().max(max).optional());

/** States a person can ask the engine to move an item to. The engine, not this list, decides legality and permission. */
export const HUMAN_TARGETS = ["IN_PROGRESS", "RESOLUTION_PROPOSED", "RESOLUTION_CONFIRMED", "CLOSED", "REOPENED"] as const;

export const transitionForm = z.object({
  itemId: uuid,
  to: z.enum(HUMAN_TARGETS),
  reason: optionalText(500),
  expectedVersion: z.coerce.number().int().min(1),
});

export const approvalForm = z.object({
  approvalRequestId: uuid,
  itemId: uuid,
  decision: z.enum(["APPROVE", "REJECT"]),
  reason: optionalText(500),
  expectedVersion: z.coerce.number().int().min(1),
});

export const ownerForm = z.object({
  itemId: uuid,
  userId: z.union([uuid, z.literal("")]).transform((v) => (v === "" ? null : v)),
});

export const reviewForm = z.object({
  taskId: uuid,
  status: z.enum(["RESOLVED", "DISMISSED"]),
  resolution: optionalText(500),
});

export const correlationForm = z.object({ candidateId: uuid, from: z.enum(["review", "item"]).default("review"), itemId: z.union([uuid, z.literal("")]).optional() });

export const markReadForm = z.object({ id: z.union([uuid, z.literal("all")]) });

export const orgForm = z.object({ organizationId: uuid });

export const devLoginForm = z.object({ email: z.string().trim().toLowerCase().email().max(320) });

/** FormData to a plain object, keeping only the first value of each key and ignoring files. */
export function formObject(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of formData.entries()) if (typeof v === "string" && !(k in out) && !k.startsWith("$ACTION")) out[k] = v;
  return out;
}

export const connectGmailForm = z.object({ teamId: uuid });
export const disconnectForm = z.object({ connectionId: uuid });
export const syncNowForm = z.object({ sourceId: uuid });

export const chatClaimForm = z.object({ space: z.string().trim().min(1).max(300), teamId: uuid });
export const claimIdForm = z.object({ claimId: uuid });
export const removeSpaceForm = z.object({ sourceId: uuid });
export const linkPersonForm = z.object({ participantId: uuid, userId: z.union([uuid, z.literal("")]).transform((v) => (v === "" ? null : v)) });

/** Numbers arrive as text; the retention module re-validates them (floors, ordering) and is the authority. */
export const revokeSessionsForm = z.object({ userId: uuid });
export const retentionForm = z.object({ rawEventDays: z.coerce.number(), messageDays: z.coerce.number() });
