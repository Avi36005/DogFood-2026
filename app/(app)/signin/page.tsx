import Link from "next/link";
import { redirect } from "next/navigation";
import { signInAction } from "@/lib/actions/auth.ts";
import { currentActor } from "@/lib/auth/session.ts";
import { Field, Input, Notice, Panel } from "@/components/app/ui";
import { ActionForm } from "@/components/app/form";
import { get } from "@/lib/db/client.ts";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function SignIn({ searchParams }: { searchParams: Promise<{ next?: string; reset?: string }> }) {
  if (await currentActor()) redirect("/dashboard");
  const { next, reset } = await searchParams;
  const seeded = (get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'seed.load'`)?.n ?? 0) > 0;

  return (
    <>
      <main className="max-w-7xl mx-auto px-6 lg:px-8 flex justify-center py-20">
        <div className="w-full max-w-[420px]">
          <h1 className="text-[30px]">Sign in</h1>
          <p className="mt-2 text-[14px] text-muted-foreground">Forgeboard keeps your account on this instance only.</p>

          {reset ? (
            <div className="mt-5">
              <Notice tone="success">
                Your password is set and every other session was signed out. Sign in with the new one.
              </Notice>
            </div>
          ) : null}

          <Panel className="mt-7 p-6">
            <ActionForm action={signInAction} submitLabel="Sign in">
              <input type="hidden" name="next" value={next ?? "/dashboard"} />
              <div className="space-y-4">
                <Field label="Email">
                  <Input name="email" type="email" autoComplete="username" required autoFocus />
                </Field>
                <Field label="Password">
                  <Input name="password" type="password" autoComplete="current-password" required />
                </Field>
              </div>
            </ActionForm>
          </Panel>

          {seeded ? (
            <Panel className="mt-4 p-5">
              <h2 className="text-[13px] font-medium text-foreground">Demo accounts</h2>
              <p className="mt-1 text-[12px] text-muted-foreground">
                This instance holds seed data. Every demo account uses the password{" "}
                <code className="font-mono text-primary">forgeboard2026</code>.
              </p>
              <ul className="mt-3 space-y-1.5 font-mono text-[12px] text-muted-foreground">
                <li>organizer@forgeboard.local <span className="text-muted-soft">— runs the event</span></li>
                <li>judge@forgeboard.local <span className="text-muted-soft">— has a review queue</span></li>
                <li>participant@forgeboard.local <span className="text-muted-soft">— owns a submission</span></li>
                <li>admin@forgeboard.local <span className="text-muted-soft">— instance admin</span></li>
              </ul>
            </Panel>
          ) : null}

          <p className="mt-6 text-center text-[13px] text-muted-foreground">
            No account?{" "}
            <Link href={`/register${next ? `?next=${encodeURIComponent(next)}` : ""}`} className="text-primary hover:underline">Create one</Link>
            <br />
            <span className="text-muted-soft">
              Lost your password? An instance admin can issue a recovery link; there is no email here.
            </span>
          </p>
        </div>
      </main>
    </>
  );
}
