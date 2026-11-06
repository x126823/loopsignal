"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ForbiddenError, revokeMemberSessions, revokeOwnSessions } from "@/modules/identity";
import { formObject, revokeSessionsForm } from "../../../_lib/forms";
import type { NoticeKey } from "../../../_lib/notices";
import { requireContext } from "../../../_lib/session";

const PAGE = "/settings/security";

/** End every session of the person using the app, this one included, so they land on the sign-in page. */
export async function signOutEverywhereAction(): Promise<void> {
  const ctx = await requireContext();
  await revokeOwnSessions(ctx.principal);
  return redirect("/login");
}

/** An administrator ends every session of a member of the organization. The module and the database both re-check the role and the membership. */
export async function revokeMemberSessionsAction(formData: FormData): Promise<void> {
  const ctx = await requireContext();
  const parsed = revokeSessionsForm.safeParse(formObject(formData));
  if (!parsed.success) return redirect(`${PAGE}?notice=invalid`);
  let key: NoticeKey;
  try {
    key = (await revokeMemberSessions(ctx.principal, parsed.data.userId)) === "REVOKED" ? "sessions_revoked" : "sessions_not_member";
  } catch (e) {
    if (!(e instanceof ForbiddenError)) throw e;
    key = "forbidden";
  }
  revalidatePath(PAGE);
  return redirect(`${PAGE}?notice=${key}`);
}
