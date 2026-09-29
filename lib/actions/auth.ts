"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import * as accounts from "../domain/accounts.ts";
import { issueSession, setSessionCookie, clearSessionCookie } from "../auth/session.ts";
import * as audit from "../domain/audit.ts";
import { get, run, nowIso } from "../db/client.ts";
import { newId } from "../ids.ts";

export type FormState = { error?: string; ok?: string };

/**
 * Only same-site paths may follow sign-in. "//evil.com" and "/\\evil.com" both
 * start with "/" but browsers treat them as another host, so they are refused.
 */
function safeNext(next: string): string {
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/dashboard";
  try {
    const u = new URL(next, "http://forgeboard.local");
    return u.host === "forgeboard.local" ? u.pathname + u.search + u.hash : "/dashboard";
  } catch {
    return "/dashboard";
  }
}

/**
 * Sign-in throttle. Counts failures per email in the audit trail and refuses
 * once they pile up, so a stolen user list cannot be sprayed at the login form.
 * Deliberately simple: no extra table, and an organizer can read the evidence.
 */
function tooManyFailures(email: string): boolean {
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const row = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM audit_events
      WHERE action = 'auth.signin' AND outcome = 'denied'
        AND subject_id = ? AND created_at > ?`,
    email.toLowerCase(), since,
  );
  return (row?.n ?? 0) >= 10;
}

export async function signInAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/dashboard");
  if (!email || !password) return { error: "Enter your email and password." };

  if (tooManyFailures(email)) {
    return { error: "Too many failed attempts for this account. Wait 15 minutes and try again." };
  }

  const user = accounts.authenticate(email, password);
  if (!user) {
    run(
      `INSERT INTO audit_events (id, actor_label, action, subject_type, subject_id, outcome, created_at)
       VALUES (?,?, 'auth.signin', 'email', ?, 'denied', ?)`,
      newId("aud"), email, email.toLowerCase(), nowIso(),
    );
    // One message for both causes: never reveal whether an address is registered.
    return { error: "Those credentials do not match an account." };
  }

  const { token, expiresAt } = issueSession(user.id);
  await setSessionCookie(token, expiresAt);
  audit.record({ actor: accounts.toActor(user), action: "auth.signin", subjectType: "user", subjectId: user.id });
  redirect(safeNext(next));
}

export async function registerAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const displayName = String(formData.get("displayName") ?? "").trim();
  try {
    // The first account on a fresh instance becomes the admin, so a self-hosted
    // deployment has an owner without a bootstrap password in the compose file.
    const isFirst = (get<{ n: number }>(`SELECT COUNT(*) AS n FROM users`)?.n ?? 0) === 0;
    const user = accounts.register({ email, password, displayName, globalRole: isFirst ? "admin" : "user" });
    const { token, expiresAt } = issueSession(user.id);
    await setSessionCookie(token, expiresAt);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not create that account." };
  }
  redirect(safeNext(String(formData.get("next") ?? "/dashboard")));
}

/** Redeems a recovery link. Every existing session for the account is dropped. */
export async function resetPasswordAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const token = String(fd.get("token") ?? "");
  const password = String(fd.get("password") ?? "");
  if (password !== String(fd.get("confirm") ?? "")) return { error: "The two passwords do not match." };
  try {
    accounts.redeemPasswordReset(token, password);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not set that password." };
  }
  redirect("/signin?reset=1");
}

export async function signOutAction() {
  await clearSessionCookie();
  revalidatePath("/");
  redirect("/");
}
