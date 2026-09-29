"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentActor } from "../auth/session.ts";
import * as accounts from "../domain/accounts.ts";
import type { FormState } from "./auth.ts";

async function requireAdmin() {
  const actor = await currentActor();
  if (!actor) redirect("/signin?next=/admin");
  if (actor.globalRole !== "admin") redirect("/dashboard");
  return actor;
}

export async function setRoleAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const admin = await requireAdmin();
    accounts.setGlobalRole(admin, String(fd.get("userId")), String(fd.get("role")) as "admin" | "user");
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not change that role." };
  }
  revalidatePath("/admin");
  return { ok: "Role updated." };
}

export type ResetState = FormState & { link?: string };

/**
 * Issues a recovery link for an account. Forgeboard sends no email, so the
 * admin passes the link on through their own channel. It is shown once here,
 * never stored in readable form, and never written to the audit trail.
 */
export async function issuePasswordResetAction(_prev: ResetState, fd: FormData): Promise<ResetState> {
  try {
    const admin = await requireAdmin();
    const user = accounts.byId(String(fd.get("userId")));
    if (!user) return { error: "That account no longer exists." };
    const { token, expiresAt } = accounts.issuePasswordReset(user, admin);
    revalidatePath("/admin");
    return {
      ok: `Recovery link for ${user.email}, valid until ${expiresAt.slice(11, 16)} UTC. It works once.`,
      link: `/reset/${token}`,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not issue a recovery link." };
  }
}

export async function setDisabledAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const admin = await requireAdmin();
    accounts.setDisabled(admin, String(fd.get("userId")), fd.get("disabled") === "1");
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not update that account." };
  }
  revalidatePath("/admin");
  return { ok: "Account updated." };
}
