"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ForbiddenError } from "@/modules/identity";
import { InvalidRetentionError, setRetention } from "@/modules/retention";
import { formObject, retentionForm } from "../../../_lib/forms";
import type { NoticeKey } from "../../../_lib/notices";
import { requireContext } from "../../../_lib/session";

const PAGE = "/settings/retention";

/** Like every server action: re-resolve the caller, validate the form as untrusted, let the module decide, report with a fixed notice. */
export async function saveRetentionAction(formData: FormData): Promise<void> {
  const ctx = await requireContext();
  const parsed = retentionForm.safeParse(formObject(formData));
  if (!parsed.success) return redirect(`${PAGE}?notice=retention_invalid`);
  let key: NoticeKey = "retention_saved";
  try {
    await setRetention(ctx.principal, parsed.data);
  } catch (e) {
    if (e instanceof ForbiddenError) key = "forbidden";
    else if (e instanceof InvalidRetentionError) key = "retention_invalid";
    else throw e;
  }
  revalidatePath(PAGE);
  return redirect(`${PAGE}?notice=${key}`);
}
