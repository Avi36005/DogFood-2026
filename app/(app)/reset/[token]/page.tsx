import Link from "next/link";
import { Field, Input, Notice, Panel, PanelHeader } from "@/components/app/ui";
import { ActionForm } from "@/components/app/form";
import { resetPasswordAction } from "@/lib/actions/auth.ts";
import * as accounts from "@/lib/domain/accounts.ts";

export const metadata = { title: "Set a new password" };
export const dynamic = "force-dynamic";

/**
 * Redeeming a recovery link. The link is the only proof required, so it is
 * one-use, expires within the hour, and using it signs the account out of
 * every session it had.
 */
export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = accounts.resetTokenUser(token);

  return (
    <div className="mx-auto max-w-lg px-6 py-16 lg:px-8">
      <Panel>
        <PanelHeader
          title="Set a new password"
          sub={user ? `For ${user.email}` : "This link cannot be used"}
        />
        <div className="space-y-5 px-6 py-6">
          {!user ? (
            <>
              <Notice tone="danger">
                This recovery link is not valid. It may have expired, been used already, or been replaced by
                a newer one.
              </Notice>
              <p className="text-[13px] text-muted-foreground">
                An instance admin can issue another from the admin screen, or the operator can run{" "}
                <code className="font-mono text-[12px]">npm run user:reset -- you@example.org</code> on the server.
              </p>
              <Link href="/signin" className="inline-block text-[13px] text-primary hover:underline">Back to sign in</Link>
            </>
          ) : (
            <>
              <ActionForm action={resetPasswordAction} submitLabel="Set password and sign out everywhere">
                <input type="hidden" name="token" value={token} />
                <div className="grid gap-5">
                  <Field label="New password" hint="At least 10 characters, including a letter and a number." required>
                    <Input name="password" type="password" autoComplete="new-password" required minLength={10} />
                  </Field>
                  <Field label="Repeat the password" required>
                    <Input name="confirm" type="password" autoComplete="new-password" required minLength={10} />
                  </Field>
                </div>
              </ActionForm>
              <p className="text-[12px] text-muted-soft">
                Every session this account currently has will be signed out, including any the person who
                issued this link might hold.
              </p>
            </>
          )}
        </div>
      </Panel>
    </div>
  );
}
