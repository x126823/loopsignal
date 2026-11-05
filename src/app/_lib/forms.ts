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

export const orgForm = z.object({ organizationId: uuid });

export const devLoginForm = z.object({ email: z.string().trim().toLowerCase().email().max(320) });

/** FormData to a plain object, keeping only the first value of each key and ignoring files. */
export function formObject(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of formData.entries()) if (typeof v === "string" && !(k in out) && !k.startsWith("$ACTION")) out[k] = v;
  return out;
}
