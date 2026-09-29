import Link from "next/link";
import { redirect } from "next/navigation";
import { registerAction } from "@/lib/actions/auth.ts";
import { currentActor } from "@/lib/auth/session.ts";
import { Field, Input, Panel, Notice } from "@/components/app/ui";
import { ActionForm } from "@/components/app/form";
import { get } from "@/lib/db/client.ts";

export const metadata = { title: "Create an account" };
export const dynamic = "force-dynamic";

export default async function Register({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  if (await currentActor()) redirect(next ?? "/dashboard");
  const isFirst = (get<{ n: number }>(`SELECT COUNT(*) AS n FROM users`)?.n ?? 0) === 0;

  return (
    <>
      <main className="max-w-7xl mx-auto px-6 lg:px-8 flex justify-center py-20">
        <div className="w-full max-w-[420px]">
          <h1 className="text-[30px]">Create an account</h1>
          <p className="mt-2 text-[14px] text-muted-foreground">Local to this instance. No email is sent and nothing leaves the server.</p>

          {isFirst ? (
            <div className="mt-5">
              <Notice tone="info">
                This is the first account on this instance, so it will be the administrator.
              </Notice>
            </div>
          ) : null}

          <Panel className="mt-6 p-6">
            <ActionForm action={registerAction} submitLabel="Create account">
              <input type="hidden" name="next" value={next ?? "/dashboard"} />
              <div className="space-y-4">
                <Field label="Display name">
                  <Input name="displayName" required autoFocus maxLength={80} />
                </Field>
                <Field label="Email">
                  <Input name="email" type="email" autoComplete="username" required />
                </Field>
                <Field label="Password" hint="At least 10 characters, including a letter and a number.">
                  <Input name="password" type="password" autoComplete="new-password" required minLength={10} />
                </Field>
              </div>
            </ActionForm>
          </Panel>

          <p className="mt-6 text-center text-[13px] text-muted-foreground">
            Already registered?{" "}
            <Link href={`/signin${next ? `?next=${encodeURIComponent(next)}` : ""}`} className="text-primary hover:underline">Sign in</Link>
          </p>
        </div>
      </main>
    </>
  );
}
