"use client";

import { useFormAction } from "./form";
import { ConfirmSubmit } from "./confirm";
import { CopyLink } from "./copy";
import { setRoleAction, setDisabledAction, issuePasswordResetAction } from "@/lib/actions/admin.ts";

/** Compact per-row controls. Self-demotion and self-disabling are refused server-side too. */
export function AccountControls({ userId, role, disabled, isSelf }: {
  userId: string; role: string; disabled: boolean; isSelf: boolean;
}) {
  const [roleState, roleAction, rolePending] = useFormAction(setRoleAction);
  const [disState, disAction, disPending] = useFormAction(setDisabledAction);
  const [resetState, resetAction, resetPending] = useFormAction(issuePasswordResetAction);
  const err = roleState.error ?? disState.error ?? resetState.error;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <form action={roleAction}>
        <input type="hidden" name="userId" value={userId} />
        <input type="hidden" name="role" value={role === "admin" ? "user" : "admin"} />
        <button
          type="submit" disabled={rolePending}
          className="rounded-md border border-control-border px-2 py-1 text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {role === "admin" ? "Demote" : "Make admin"}
        </button>
      </form>

      {!isSelf ? (
        <form action={disAction}>
          <input type="hidden" name="userId" value={userId} />
          <input type="hidden" name="disabled" value={disabled ? "0" : "1"} />
          {disabled ? (
            <button
              type="submit" disabled={disPending}
              className="rounded-md border border-control-border px-2 py-1 text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              Enable
            </button>
          ) : (
            <ConfirmSubmit
              compact label="Disable" confirmLabel="Disable"
              question="Disable this account? Its sessions are signed out immediately."
              pending={disPending}
            />
          )}
        </form>
      ) : null}

      {/* No email here: the admin hands the link over themselves. */}
      <form action={resetAction}>
        <input type="hidden" name="userId" value={userId} />
        <button
          type="submit" disabled={resetPending}
          className="rounded-md border border-control-border px-2 py-1 text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {resetPending ? "Issuing…" : "Recovery link"}
        </button>
      </form>

      {err ? <span className="text-[11px] text-destructive">{err}</span> : null}
      {resetState.link ? (
        <div className="w-full">
          <p className="mb-1 text-[11px] text-success">{resetState.ok}</p>
          <CopyLink path={resetState.link} label="Password recovery link" />
        </div>
      ) : null}
    </div>
  );
}
